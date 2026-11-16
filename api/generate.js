module.exports = async (req, res) => {
  // Allow only POST requests
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed. Use POST."
    });
  }

  try {
    const { mode, prompt } = req.body || {};

    // Validate request
    if (!mode || !["video", "music-video"].includes(mode)) {
      return res.status(400).json({
        success: false,
        error: "Invalid mode. Use 'video' or 'music-video'."
      });
    }

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({
        success: false,
        error: "A video prompt is required."
      });
    }

    if (prompt.length > 10000) {
      return res.status(400).json({
        success: false,
        error: "The prompt is too long."
      });
    }

    // AI video provider will be connected here later.
    return res.status(501).json({
      success: false,
      status: "provider_not_configured",
      message:
        "The video generation provider has not been connected yet."
    });

  } catch (error) {
    console.error("Generation API error:", error);

    return res.status(500).json({
      success: false,
      error: "An internal server error occurred."
    });
  }
};
