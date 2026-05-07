const axios = require('axios');

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

async function postToBuffer(text, media, options = {}) {
  const apiKey =
    process.env.BUFFER_TOKEN ||
    process.env.BUFFER_OUTLOOK ||
    process.env.BUFFER_LDOUTLOOK;

  if (!apiKey) {
    throw new Error(
      "Buffer configuration missing. Set BUFFER_TOKEN (or BUFFER_OUTLOOK / BUFFER_LDOUTLOOK) in your environment."
    );
  }

  const BUFFER_GRAPHQL_URL =
    process.env.BUFFER_GRAPHQL_URL || 'https://api.buffer.com/graphql';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };

  try {
    const requestedServices = (options.platforms || [])
      .map(mapUiPlatformToBufferService)
      .filter(Boolean);

    if (requestedServices.length === 0) {
      throw new Error('Select at least one platform to post.');
    }

    // 1. Get Organizations
    const orgsRes = await axios.post(BUFFER_GRAPHQL_URL, {
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
    }, { headers });

    if (orgsRes.data.errors) {
      throw new Error(`Organizations Query: ${orgsRes.data.errors.map(e => e.message).join(', ')}`);
    }

    const organizations = orgsRes.data.data?.account?.organizations || [];
    if (organizations.length === 0) {
      throw new Error("No organizations found for this Buffer account.");
    }

    // 2. Get Channels for each Organization
    let allChannels = [];
    for (const org of organizations) {
      const channelsRes = await axios.post(BUFFER_GRAPHQL_URL, {
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
      }, { headers });

      if (channelsRes.data.errors) {
        throw new Error(`Channels Query (${org.name}): ${channelsRes.data.errors.map(e => e.message).join(', ')}`);
      }

      if (channelsRes.data.data?.channels) {
        allChannels = allChannels.concat(channelsRes.data.data.channels);
      }
    }

    if (allChannels.length === 0) {
      throw new Error("No social channels found connected to your Buffer organizations.");
    }

    const selectedChannels = allChannels.filter((c) =>
      requestedServices.includes(normalizeService(c.service))
    );

    if (selectedChannels.length === 0) {
      const available = Array.from(
        new Set(allChannels.map((c) => normalizeService(c.service)).filter(Boolean))
      ).sort();
      throw new Error(
        `No Buffer channels match the selected platforms. Selected: ${requestedServices.join(
          ', '
        )}. Available in Buffer: ${available.join(', ') || '(none)'}.`
      );
    }

    // 3. Post the message to each selected channel discovered in parallel
    const postResults = await Promise.all(selectedChannels.map(async (channel) => {
      try {
        const res = await axios.post(BUFFER_GRAPHQL_URL, {
          query: `
          mutation CreatePost($text: String!, $channelId: ChannelId!) {
            createPost(input: {
              text: $text,
              channelId: $channelId,
              schedulingType: automatic,
              mode: addToQueue
            }) {
              ... on PostActionSuccess { post { id } }
              ... on MutationError { message }
            }
          }
          `,
          variables: { text, channelId: channel.id },
        }, { headers });

        if (res.data.errors) {
          return { channel: channel.name, error: res.data.errors.map(e => e.message).join(', ') };
        }
        if (res.data.data?.createPost?.message) {
          return { channel: channel.name, error: res.data.data.createPost.message };
        }
        return { channel: channel.name, success: true };
      } catch (err) {
        const errMsg = err.response?.data?.errors?.[0]?.message || err.response?.data?.message || err.message;
        return { channel: channel.name, error: errMsg };
      }
    }));

    const failures = postResults.filter(r => r.error);
    if (failures.length > 0) {
      const detail = failures.map(f => `${f.channel}: ${f.error}`).join('; ');
      throw new Error(`Buffer Posting Error: ${detail}`);
    }

    return `Successfully queued updates to ${selectedChannels.length} channel(s) via Buffer.`;
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
