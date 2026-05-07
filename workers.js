const axios = require('axios');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');

/**
 * Worker module for Buffer integration via GraphQL API.
 * This enables "one-click" publishing by automatically discovering all organizations
 * and their associated social channels to broadcast the message.
 */

function normalizeService(value) {
  return String(value || '').trim().toLowerCase();
}

function mapUiPlatformToBufferService(platform) {
  const p = normalizeService(platform);
  switch (p) {
    case 'twitter':
    case 'x':
      return 'twitter';
    case 'linkedin':
      return 'linkedin';
    case 'instagram':
      return 'instagram';
    case 'mastodon':
      return 'mastodon';
    case 'threads':
      return 'threads';
    case 'bluesky':
      return 'bluesky';
    case 'facebook':
      return 'facebook';
    default:
      return null;
  }
}

async function uploadToImgBB(localFilePath, mimeType) {
  const apiKey = process.env.IMG_BB_API_KEY;
  if (!apiKey) {
    throw new Error('ImgBB configuration missing (IMG_BB_API_KEY).');
  }

  if (!localFilePath || !fs.existsSync(localFilePath)) {
    throw new Error(`ImgBB upload failed: local file not found at ${localFilePath}`);
  }

  // ImgBB supports images; for non-images, fall back to local URL (requires PUBLIC_BASE_URL tunnel)
  if (!String(mimeType || '').toLowerCase().startsWith('image/')) {
    return null;
  }

  const endpoint = new URL('https://api.imgbb.com/1/upload');
  endpoint.searchParams.set('key', apiKey);

  const form = new FormData();
  form.append('image', fs.createReadStream(localFilePath));

  const res = await axios.post(endpoint.toString(), form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  if (!res.data?.success) {
    const msg = res.data?.error?.message || res.data?.error || 'Unknown ImgBB error';
    throw new Error(`ImgBB API Error: ${msg}`);
  }

  const url = res.data?.data?.url || res.data?.data?.display_url;
  if (!url) {
    throw new Error('ImgBB upload succeeded but no URL was returned.');
  }
  return url;
}

async function postToBuffer(text, media, options = {}) {
  const BUFFER_GRAPHQL_URL =
    process.env.BUFFER_GRAPHQL_URL || 'https://api.buffer.com/graphql';

  try {
    const requestedServices = (options.platforms || [])
      .map(mapUiPlatformToBufferService)
      .filter(Boolean);

    if (requestedServices.length === 0) {
      throw new Error('Select at least one platform to post.');
    }

    const LD_SERVICES = new Set(['twitter', 'mastodon', 'threads']);
    const requestedForLd = requestedServices.filter((s) => LD_SERVICES.has(s));
    const requestedForOutlook = requestedServices.filter((s) => !LD_SERVICES.has(s));

    const apiKeyLd = process.env.BUFFER_LDOUTLOOK;
    const apiKeyOutlook = process.env.BUFFER_OUTLOOK;

    let mediaUrl = options.mediaUrl || null;
    if (!mediaUrl && media && process.env.IMG_BB_API_KEY) {
      const localPath = media.path || path.join(__dirname, 'uploads', media.filename || '');
      mediaUrl = await uploadToImgBB(localPath, media?.mimetype);
    }
    const mediaMime = normalizeService(media?.mimetype);
    const hasMedia = Boolean(mediaUrl);
    const isImage = hasMedia && mediaMime.startsWith('image/');
    const isVideo = hasMedia && mediaMime.startsWith('video/');

    async function postWithToken(apiKey, servicesWanted) {
      if (!apiKey) {
        throw new Error(
          `Buffer configuration missing for ${servicesWanted.join(
            ', '
          )}. Set the appropriate token in .env.`
        );
      }

      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      };

      // 1. Get Organizations
      const orgsRes = await axios.post(
        BUFFER_GRAPHQL_URL,
        {
          query: `
          query GetOrganizations {
            account {
              organizations {
                id
                name
              }
            }
          }
          `,
        },
        { headers }
      );

      if (orgsRes.data.errors) {
        throw new Error(
          `Organizations Query: ${orgsRes.data.errors.map((e) => e.message).join(', ')}`
        );
      }

      const organizations = orgsRes.data.data?.account?.organizations || [];
      if (organizations.length === 0) {
        throw new Error('No organizations found for this Buffer account.');
      }

      // 2. Get Channels for each Organization
      let allChannels = [];
      for (const org of organizations) {
        const channelsRes = await axios.post(
          BUFFER_GRAPHQL_URL,
          {
            query: `
            query GetChannels($orgId: OrganizationId!) {
              channels(input: { organizationId: $orgId }) {
                id
                name
                service
              }
            }
            `,
            variables: { orgId: org.id },
          },
          { headers }
        );

        if (channelsRes.data.errors) {
          throw new Error(
            `Channels Query (${org.name}): ${channelsRes.data.errors
              .map((e) => e.message)
              .join(', ')}`
          );
        }

        if (channelsRes.data.data?.channels) {
          allChannels = allChannels.concat(channelsRes.data.data.channels);
        }
      }

      if (allChannels.length === 0) {
        throw new Error('No social channels found connected to your Buffer organizations.');
      }

      const selectedChannels = allChannels.filter((c) =>
        servicesWanted.includes(normalizeService(c.service))
      );

      if (selectedChannels.length === 0) {
        const available = Array.from(
          new Set(allChannels.map((c) => normalizeService(c.service)).filter(Boolean))
        ).sort();
        throw new Error(
          `No Buffer channels match the selected platforms. Selected: ${servicesWanted.join(
            ', '
          )}. Available in Buffer: ${available.join(', ') || '(none)'}.`
        );
      }

      // 3. Post the message to each selected channel discovered in parallel
      const postResults = await Promise.all(
        selectedChannels.map(async (channel) => {
          try {
            const assetsPart = (() => {
              if (!hasMedia) return '';
              console.log (mediaUrl);
              const safeUrl = JSON.stringify(mediaUrl);
              if (isImage) {
                return `\n                    assets: { images: [{ url: ${safeUrl} }] }`;
              }
              if (isVideo) {
                return `\n                    assets: { videos: [{ url: ${safeUrl} }] }`;
              }
              return '';
            })();

            const res = await axios.post(
              BUFFER_GRAPHQL_URL,
              {
                query: `
                mutation CreatePost($text: String!, $channelId: ChannelId!) {
                  createPost(input: {
                    text: $text,
                    channelId: $channelId,
                    schedulingType: automatic,
                    mode: addToQueue${assetsPart ? ',' : ''}${assetsPart}
                  }) {
                    ... on PostActionSuccess { post { id } }
                    ... on MutationError { message }
                  }
                }
                `,
                variables: { text, channelId: channel.id },
              },
              { headers }
            );

            if (res.data.errors) {
              return { channel: channel.name, error: res.data.errors.map((e) => e.message).join(', ') };
            }
            if (res.data.data?.createPost?.message) {
              return { channel: channel.name, error: res.data.data.createPost.message };
            }
            return { channel: channel.name, success: true };
          } catch (err) {
            const errMsg =
              err.response?.data?.errors?.[0]?.message ||
              err.response?.data?.message ||
              err.message;
            return { channel: channel.name, error: errMsg };
          }
        })
      );

      const failures = postResults.filter((r) => r.error);
      if (failures.length > 0) {
        const detail = failures.map((f) => `${f.channel}: ${f.error}`).join('; ');
        throw new Error(`Buffer Posting Error: ${detail}`);
      }

      return { count: selectedChannels.length };
    }

    let total = 0;
    const parts = [];

    if (requestedForLd.length > 0) {
      const { count } = await postWithToken(apiKeyLd, requestedForLd);
      total += count;
      parts.push(`${count} via BUFFER_LDOUTLOOK`);
    }

    if (requestedForOutlook.length > 0) {
      const { count } = await postWithToken(apiKeyOutlook, requestedForOutlook);
      total += count;
      parts.push(`${count} via BUFFER_OUTLOOK`);
    }

    return `Successfully queued updates to ${total} channel(s) via Buffer (${parts.join(', ')}).`;
  } catch (error) {
    // Extract specific API error message if available (e.g. from 401 Unauthorized)
    const apiMsg = error.response?.data?.errors?.[0]?.message || error.response?.data?.message;
    if (apiMsg) {
      throw new Error(`Buffer API Error: ${apiMsg}`);
    }
    throw error;
  }
}

module.exports = {
  postToBuffer
};
