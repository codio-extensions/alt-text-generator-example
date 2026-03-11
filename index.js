// Wrapping the whole extension in a JS function
// (ensures all global variables set in this extension cannot be referenced outside its scope)
(async function(codioIDE, window) {

    // Refer to Anthropic's guide on system prompts here: https://docs.anthropic.com/claude/docs/system-prompts
    const systemPrompt = "You are a helpful assistant with an expertise at writing alt text for images. Your response must always be in plain English, a sentence or a paragraph of 3-4 sentences, with no new lines and no bullet points."

    // register(id: unique button id, name: name of button visible in Coach, function: function to call when button is clicked)
    codioIDE.coachBot.register("altTextGenButton", "Generate Alt text for all images", onButtonPress)

    function getMediaType(filePath) {
      const baseName = filePath.split(/[\\/]/).pop() || '';
      const dotIndex = baseName.lastIndexOf('.');
      const ext = dotIndex >= 0 ? baseName.slice(dotIndex + 1).toLowerCase() : '';

      switch (ext) {
        case 'jpg':
        case 'jpeg':
          return 'image/jpeg';
        case 'png':
          return 'image/png';
        case 'gif':
          return 'image/gif';
        case 'webp':
          return 'image/webp';
        default:
          throw new Error(`Unsupported image extension: ${ext}`);
      }
    }

    const GENERIC_ALT_TERMS = /^(image|img|photo|picture|pic|screenshot|screen shot|figure|fig|graphic|icon|logo|banner|thumbnail|thumb|placeholder|untitled)$/i
    const FILENAME_PATTERN = /^[\w\-]+\.\w{2,5}$/

    function isMeaningfulAltText(altText) {
      const trimmed = altText.trim()
      if (trimmed.length === 0) return false
      if (trimmed.length < 20) return false
      if (GENERIC_ALT_TERMS.test(trimmed)) return false
      if (FILENAME_PATTERN.test(trimmed)) return false
      return true
    }

    // function called when I have a question button is pressed
    async function onButtonPress() {

      codioIDE.coachBot.write(`Generating alt text for ya my bestie... give me a sec and I'll get started!`);
      codioIDE.coachBot.showThinkingAnimation()

      // Get guideStructure to extract pages
      const guidesStructure = await codioIDE.guides.structure.getStructure()
      console.log("This is the guides structure", guidesStructure)

      const findPagesFilter = (obj) => {
          if (!obj || typeof obj !== 'object') return [];

          return [
              ...(obj.type === 'page' ? [obj] : []),
              ...Object.values(obj).flatMap(findPagesFilter)
          ];
      };

      const pages = findPagesFilter(guidesStructure)
      const totalPages = pages.length

      // Regex pattern to find images in markdown ![alt text](image_path)
      const pattern = /!\[.*?\]\(.*?\)/g

      // aws lambda function url
      const lambdaUrl = 'https://wrib7ayaikuoognvwh4xjlqtim0zunnd.lambda-url.us-east-2.on.aws/';

      // Counters for final summary
      let totalImagesProcessed = 0
      let totalPagesWithImages = 0
      let totalImagesSkippedErrors = 0

      // extract page content for each guide page
      for (const element_index in pages) {
        let pageNumber = parseInt(element_index, 10) + 1
        let page_id = pages[element_index].id
        let pageData = await codioIDE.guides.structure.get(page_id)
        let pageContent = pageData.settings.content
        let pageTitle = pages[element_index].title

        codioIDE.coachBot.hideThinkingAnimation()
        codioIDE.coachBot.write(`Searching page ${pageNumber} of ${totalPages}: ${pageTitle}`);
        codioIDE.coachBot.showThinkingAnimation()

        console.log(`Searching page ${pageNumber} of ${totalPages}: ${pageTitle}`)

        // Search for markdown formatting of images on this page
        const matches = [...pageContent.matchAll(pattern)];

        if (matches.length > 0) {
          console.log("matches object", matches)

          codioIDE.coachBot.hideThinkingAnimation()
          codioIDE.coachBot.write(`Found ${matches.length} images on this page!`);
          codioIDE.coachBot.showThinkingAnimation()

          let alt_text_replacements = []
          let skippedImages = []
          let alreadyHadAlt = 0

          // for each match, extract filepath and alt text sections
          await Promise.allSettled(matches.map(async (match, index) => {
            const matchNumber = index + 1
            console.log(`This is match object ${matchNumber}: ${match[0]}`)
            console.log("Page id with matches: ", page_id)

            try {
              const og_alt_text_match = match[0].match(/(?<=\[)(.*?)(?=\])/)
              const existingAlt = og_alt_text_match ? og_alt_text_match[0].trim() : ''

              if (isMeaningfulAltText(existingAlt)) {
                console.log(`Image ${matchNumber} already has meaningful alt text, skipping.`)
                alreadyHadAlt++
                return
              }

              const og_filepath_match = match[0].match(/(?<=\()(.*?)(?=\))/)
              if (!og_filepath_match || !og_filepath_match[0]) {
                throw new Error('Could not extract image filepath from markdown.')
              }

              // converting img to base64
              const filepath = og_filepath_match[0]
              const imgFile = await window.codioIDE.files.getFileBase64(filepath)
              const mediaType = getMediaType(filepath)

              const postData = {
                imgData: imgFile
              };

              const options = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(postData),
              };

              const params = new URLSearchParams({
                prompt: `This image is on a page titled: ${pageTitle}. Provide only the alt text for this image. Respond with clarity and brevity.`,
                systemPrompt: systemPrompt,
                mediaType: mediaType
              });

              console.log("These are the params", params.toString())

              // set up url with query string params
              const urlWithParams = `${lambdaUrl}?${params.toString()}`;

              // Retry logic: up to 3 attempts for the Lambda call
              let data = null;
              const maxRetries = 3;

              for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                  const fetchRequest = await fetch(urlWithParams, options);

                  if (!fetchRequest.ok) {
                    const errorText = await fetchRequest.text();
                    throw new Error(`HTTP ${fetchRequest.status}: ${errorText}`);
                  }

                  data = await fetchRequest.json();
                  break; // success, exit retry loop
                } catch (fetchError) {
                  console.error(`Attempt ${attempt}/${maxRetries} failed for ${filepath}:`, fetchError);
                  if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                  } else {
                    throw fetchError; // all retries exhausted, let outer catch handle it
                  }
                }
              }

              const llmResponse = data?.responseText;
              if (!llmResponse) {
                throw new Error('Lambda returned no responseText.');
              }

              alt_text_replacements.push({
                og_match_string: match[0],
                updated_with_alt_text: `![${llmResponse}](${filepath})`
              });

              codioIDE.coachBot.hideThinkingAnimation()
              codioIDE.coachBot.write(`Generated alt text for image ${matchNumber} of ${matches.length}`);
              codioIDE.coachBot.showThinkingAnimation()

            } catch (error) {
              console.error(`Error processing image ${matchNumber} on page ${pageNumber}:`, error);
              skippedImages.push(`Image ${matchNumber} (${match[0]}): ${error.message}`);
            }
          }));

          console.log("Here are the alt text replacements", alt_text_replacements)

          // Update counters
          totalImagesProcessed += alt_text_replacements.length
          totalImagesSkippedErrors += skippedImages.length
          if (alt_text_replacements.length > 0) {
            totalPagesWithImages++
          }

          // Report skipped images to the user
          if (skippedImages.length > 0) {
            codioIDE.coachBot.hideThinkingAnimation()
            codioIDE.coachBot.write(`Warning: ${skippedImages.length} out of ${matches.length} image(s) on page ${pageNumber} could not be processed:\n${skippedImages.join('\n')}`);
            codioIDE.coachBot.showThinkingAnimation()
          }

          // now let's replace the alt text in the original content page and update it
          for (const match of alt_text_replacements) {
            pageContent = pageContent.replaceAll(match.og_match_string, match.updated_with_alt_text)
          }
          console.log("updated page content", pageContent)

          // Only update the page if we actually made changes
          if (alt_text_replacements.length > 0) {
            try {
              console.log("Page id for updates: ", page_id)
              const updateRes = await window.codioIDE.guides.structure.update(page_id, {
                title: pageTitle,
                content: pageContent
              })
              console.log('item updated', updateRes)
            } catch (e) {
              console.error(e)
            }
          }

          // Conditional success messaging
          const totalOnPage = matches.length
          const succeeded = alt_text_replacements.length
          const skipped = skippedImages.length

          codioIDE.coachBot.hideThinkingAnimation()
          if (alreadyHadAlt === totalOnPage) {
            codioIDE.coachBot.write(`All images on this page already have alt text.`);
          } else if (skipped === 0 && alreadyHadAlt === 0) {
            codioIDE.coachBot.write(`Updated alt text for ${succeeded} image(s) on this page!`);
          } else if (succeeded > 0) {
            codioIDE.coachBot.write(`Updated ${succeeded} of ${totalOnPage} image(s) on this page.`);
          }
          codioIDE.coachBot.showThinkingAnimation()
          // If succeeded === 0 and not all already had alt, the warning is sufficient
        } else {
          console.log("No matches on this page")
        }
      }

      // Final summary
      let summary = `Done! Processed ${totalImagesProcessed} image(s) across ${totalPagesWithImages} page(s).`
      if (totalImagesSkippedErrors > 0) {
        summary += ` ${totalImagesSkippedErrors} image(s) were skipped due to errors.`
      }

      codioIDE.coachBot.hideThinkingAnimation()
      codioIDE.coachBot.write(summary);
      codioIDE.coachBot.showMenu()
    }
  // calling the function immediately by passing the required variables
})(window.codioIDE, window)
