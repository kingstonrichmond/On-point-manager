// Netlify serverless function — proxies requests to the Anthropic API so
// the API key never sits in browser-visible code. Deploy this alongside
// pizza-shop-manager.html (see SETUP.md for the folder layout) and set
// ANTHROPIC_API_KEY in Netlify's Site settings → Environment variables.

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY is not set in Netlify's environment variables." }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  try {
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: payload.model || "claude-sonnet-4-6",
        max_tokens: payload.max_tokens || 1000,
        system: payload.system,
        messages: payload.messages,
      }),
    });

    const data = await anthropicRes.json();

    return {
      statusCode: anthropicRes.status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: String(err) }),
    };
  }
};
