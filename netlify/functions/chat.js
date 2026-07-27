// netlify/functions/chat.js
// Proxies requests to the Anthropic API so the API key never reaches the browser.
// Requires env var ANTHROPIC_API_KEY set in Netlify: Site settings > Environment variables.

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: { message: "Use POST. This endpoint is alive." } })
    };
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: { message: "ANTHROPIC_API_KEY is not set on this Netlify site. Add it under Site settings > Environment variables, then redeploy." }
      })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: { message: "Request body was not valid JSON." } })
    };
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text();

    // Pass the upstream status through so the app can show the real problem
    // (401 = bad key, 404 = bad model name, 429 = rate limit, 400 = bad request).
    return { statusCode: res.status, headers, body: text };
  } catch (e) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: { message: "Netlify function could not reach the Anthropic API: " + (e.message || String(e)) }
      })
    };
  }
};
