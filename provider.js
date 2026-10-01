const gemini = require("./providers/gemini");

function getProvider() {
  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  if (provider !== "gemini") throw new Error(`Unsupported AI_PROVIDER: ${provider}`);
  return gemini;
}

module.exports = { getProvider };
