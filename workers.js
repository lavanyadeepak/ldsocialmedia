const axios = require('axios');

/**
 * Worker module for Buffer integration via GraphQL API.
 * This enables "one-click" publishing by automatically discovering all organizations
 * and their associated social channels to broadcast the message.
 */

async function postToBuffer(text, media) {
  const apiKey =
    process.env.BUFFER_TOKEN ||
    process.env.BUFFER_OUTLOOK ||
    process.env.BUFFER_LDOUTLOOK;

  if (!apiKey) {
    throw new Error(
      "Buffer configuration missing. Set BUFFER_TOKEN (or BUFFER_OUTLOOK / BUFFER_LDOUTLOOK) in your environment."
    );

    console.log ("Buffer API Key:", apiKey); // Debug log to verify the API key being used
  }

  const BUFFER_GRAPHQL_URL =
    process.env.BUFFER_GRAPHQL_URL || 'https://api.buffer.com/graphql';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };

  try {
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

    // 3. Post the message to each channel discovered in parallel
    const postResults = await Promise.all(allChannels.map(async (channel) => {
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

    return `Successfully queued updates to ${allChannels.length} channel(s) via Buffer.`;
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
