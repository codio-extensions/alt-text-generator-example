// Wrapping the whole extension in a JS function
// (ensures all global variables set in this extension cannot be referenced outside its scope)
(async function (codioIDE, window) {

  // Refer to Anthropic's guide on system prompts here: https://docs.anthropic.com/claude/docs/system-prompts
  const systemPrompt =
    "You are a helpful assistant with an expertise at writing alt text for images. Your response must always be in plain English, a sentence or a paragraph of 3-4 sentences, with no new lines and no bullet points.";

  // register(id: unique button id, name: name of button visible in Coach, function: function to call when button is clicked)
  codioIDE.coachBot.register("altTextGenButton", "Generate Alt text for all images", onButtonPress);

  async function onButtonPress() {
    codioIDE.coachBot.write(`Generating alt text for ya my bestie... give me a sec and I'll get started!`);

    // Get guideStructure to extract pages
    const guidesStructure = await codioIDE.guides.structure.getStructure();
    console.log("This is the guides structure", guidesStructure);

    const findPagesFilter = (obj) => {
      if (!obj || typeof obj !== "object") return [];
      return [
        ...(obj.type === "page" ? [obj] : []),
        ...Object.values(obj).flatMap(findPagesFilter),
      ];
    };

    const pages = findPagesFilter(guidesStructure);

    // Newline-safe markdown image regex:
    // - matches ![...](path) even if alt text contains newlines
    // - captures the path in match[1]
    // - supports optional markdown title: ![alt](path "title")
    const pattern = /!\[[\s\S]*?\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

    // aws lambda function url
    const lambdaUrl = "https://wrib7ayaikuoognvwh4xjlqtim0zunnd.lambda-url.us-east-2.on.aws/";

    // helper: extension -> mime subtype normalization
    function getFileExtension(filePath) {
      const baseName = filePath.split(/[\\/]/).pop();
      const dotIndex = baseName.lastIndexOf(".");
      return dotIndex >= 0 ? baseName.slice(dotIndex + 1) : "";
    }

    function normalizeImageSubtype(ext) {
      let imageType = (ext || "").toLowerCase();
      if (imageType === "jpg") imageType = "jpeg";
      if (imageType === "svg") imageType = "svg+xml";
      if (!imageType) imageType = "png";
      return imageType;
    }

    // helper: sanitize model output so it can't break markdown / future parsing
    function sanitizeAltText(text) {
      return (text ?? "")
        .toString()
        .replace(/[\r\n]+/g, " ")  // remove newlines
        .replace(/\s+/g, " ")      // collapse whitespace
        .replace(/[\[\]]/g, "")    // remove square brackets (markdown-structure breakers)
        .trim();
    }

    // extract page content for each guide page
    for (const element_index in pages) {
      const pageNumber = parseInt(element_index, 10) + 1;
      const page_id = pages[element_index].id;

      const pageData = await codioIDE.guides.structure.get(page_id);
      let pageContent = pageData.settings.content;
      const pageTitle = pages[element_index].title;

      codioIDE.coachBot.write(`Searching on page ${pageNumber}: ${pageTitle}`);
      console.log(`Searching on page ${pageNumber}: ${pageTitle}`);

      // Search for markdown formatting of images on this page
      const matches = [...pageContent.matchAll(pattern)];

      if (matches.length > 0) {
        console.log("matches object", matches);
        codioIDE.coachBot.write(`Found ${matches.length} images on this page!`);

        const alt_text_replacements = [];

        // Process each match, but never fail the whole page if one image errors
        const results = await Promise.allSettled(
          matches.map(async (match, idx) => {
            try {
              // IMPORTANT FIX: filepath is captured by the regex in match[1]
              const filepath = (match[1] || "").trim();
              if (!filepath) {
                throw new Error("Could not extract image filepath from markdown.");
              }

              // converting img to base64 (this can throw if file not found)
              const imgFile = await window.codioIDE.files.getFileBase64(filepath);

              const ext = getFileExtension(filepath);
              const imageSubtype = normalizeImageSubtype(ext);

              const postData = { imgData: imgFile };
              const options = {
                method: "POST",
                body: JSON.stringify(postData),
              };

              const params = new URLSearchParams({
                prompt: `This image is on a page titled: ${pageTitle} Provide only the alt text for this image. Respond with clarity and brevity.`,
                systemPrompt: systemPrompt,
                mediaType: `image/${imageSubtype}`,
              });

              const urlWithParams = `${lambdaUrl}?${params.toString()}`;

              const fetchRequest = await fetch(urlWithParams, options);
              if (!fetchRequest.ok) {
                throw new Error(`HTTP error! status: ${fetchRequest.status}`);
              }

              const data = await fetchRequest.json();

              // IMPORTANT FIX: sanitize so alt text can't break markdown on later runs
              let llmResponse = sanitizeAltText(data.responseText);

              if (!llmResponse) {
                throw new Error("Empty alt-text returned by model.");
              }

              alt_text_replacements.push({
                og_match_string: match[0],
                updated_with_alt_text: `![${llmResponse}](${filepath})`,
              });

              return { ok: true, idx, filepath };
            } catch (error) {
              console.error(
                `Alt-text generation failed for image #${idx + 1} on page "${pageTitle}":`,
                error
              );

              // Tell the user *which* image failed, but continue processing
              codioIDE.coachBot.write(
                `⚠️ Skipping one image on this page (image #${idx + 1}) because of an error: ${error?.message || error}`
              );

              return { ok: false, idx, error: error?.message || String(error) };
            }
          })
        );

        console.log("Promise results (settled)", results);
        console.log("Here are the alt text replacements", alt_text_replacements);

        // Replace all occurrences of each original match
        for (const rep of alt_text_replacements) {
          pageContent = pageContent.split(rep.og_match_string).join(rep.updated_with_alt_text);
        }

        console.log("updated page content", pageContent);

        try {
          console.log("Page id for updates: ", page_id);
          const updateRes = await window.codioIDE.guides.structure.update(page_id, {
            title: pageTitle,
            content: pageContent,
          });
          console.log("item updated", updateRes);
        } catch (e) {
          console.error(e);
        }

        codioIDE.coachBot.write(`Alt text for images on this page is updated! Moving on...`);
      } else {
        console.log("No matches on this page");
        codioIDE.coachBot.write(`No images here, let's move on...`);
      }
    }

    codioIDE.coachBot.write(`All images in this assignment have been processed! 🐣`);
    codioIDE.coachBot.showMenu();
  }

  // calling the function immediately by passing the required variables
})(window.codioIDE, window);
