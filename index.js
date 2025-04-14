// Wrapping the whole extension in a JS function 
// (ensures all global variables set in this extension cannot be referenced outside its scope)
(async function(codioIDE, window) {
  
  // Refer to Anthropic's guide on system prompts here: https://docs.anthropic.com/claude/docs/system-prompts
  const systemPrompt = "You are a helpful assistant with an expertise at writing alt text for images. Your response must always be in plain English, a sentence or a paragraph of 3-4 sentences, with no new lines and no bullet points."
  
  // register(id: unique button id, name: name of button visible in Coach, function: function to call when button is clicked) 
  codioIDE.coachBot.register("altTextGenButton", "Generate Alt text for all images", onButtonPress)

  // function called when I have a question button is pressed
  async function onButtonPress() {
    
    codioIDE.coachBot.write(`Generating alt text for ya my bestie... give me a sec and I'll get started!`);

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
    // console.log("pages", pages)

    // // Regex pattern to find images in markdown ![alt text](image_path)
    // // const pattern = /!\[(.*)\]\((\.guides\/img\/.*)\)/
    const pattern = /!\[.*?\]\(.*?\)/g

    // aws lambda function url
    const lambdaUrl = 'https://wrib7ayaikuoognvwh4xjlqtim0zunnd.lambda-url.us-east-2.on.aws/';

    // extract page content for each guide page
    for ( const element_index in pages) {
      let pageNumber = parseInt(element_index)+1
      let page_id = pages[element_index].id
      // console.log("Page id: ", page_id)
      let pageData = await codioIDE.guides.structure.get(page_id)
      let pageContent = pageData.settings.content
      let pageTitle = pages[element_index].title
      codioIDE.coachBot.write(`Searching on page ${pageNumber}: ${pageTitle}`);
      console.log(`Searching on page ${pageNumber}: ${pageTitle}`)

      //Search for markdown formatting of images on this page
      const matches = [...pageContent.matchAll(pattern)];

      if (matches.length > 0) {
        console.log("matches object", matches)
        codioIDE.coachBot.write(`Found ${matches.length} images on this page!`);
        
        let alt_text_replacements = []

        let matchCount = 0
        // for each match, extract filepath and alt text sections

        await Promise.all(matches.map(async (match, matchCount) => {
          matchCount += 1
          console.log(`This is match object ${matchCount}: ${match[0]}`)
          
          console.log("Page id with matches: ", page_id)

          const og_alt_text_match = match[0].match(/(?<=\[)(.*?)(?=\])/)
          const og_filepath_match = match[0].match(/(?<=\()(.*?)(?=\))/)

          // console.log("og alt text", og_alt_text_match[0])
          // console.log("filepath", og_filepath_match[0])

          // converting img to base64
          const filepath = og_filepath_match[0]    
          const imgFile = await window.codioIDE.files.getFileBase64(filepath)
          // console.log("base 64 data", imgFile)

          // prepare parameters of http post request to aws lambda
          function getFileExtension(filePath) {
            const baseName = filePath.split(/[\\/]/).pop();
            const dotIndex = baseName.lastIndexOf('.');
            return baseName.slice(dotIndex + 1);
          }

          const imageType = getFileExtension(filepath)
          // console.log(imageType)

          const postData = {
            "imgData": imgFile
          };

          const options = {
            method: 'POST',
            body: JSON.stringify(postData),
          };

          const params = new URLSearchParams({
            prompt: `This image is on a page titled: ${pageTitle} 
            Provide only the alt text for this image. Respond with clarity and brevity.`,
            systemPrompt: systemPrompt,
            mediaType: `image/${imageType}`
          });
          
          console.log("These are the params", params.toString)

          // set up url with query string params
          const urlWithParams = `${lambdaUrl}?${params.toString()}`;
          // console.log(urlWithParams)

          try {
            const fetchRequest = await fetch(urlWithParams, options);
            if (!fetchRequest.ok) {
              throw new Error(`HTTP error! status: ${fetchRequest.status}`);
            }
            const data = await fetchRequest.json();
            const llmResponse = data.responseText;
            
            alt_text_replacements.push({
              "og_match_string": match[0],
              "updated_with_alt_text": `![${llmResponse}](${filepath})`
            });
          } catch (error) {
            console.error('Error fetching data:', error);
          }
        }));

        console.log("Here are the alt text replacements", alt_text_replacements)

        // now let's replace the alt text in the original content page and update it
        for (const match of alt_text_replacements) {
          // console.log("match_string", match.og_match_string)
          // console.log("alt text rep", match.updated_with_alt_text)
          pageContent = pageContent.replace(match.og_match_string, match.updated_with_alt_text)
        }
        console.log("updated page content", pageContent)
        
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

        codioIDE.coachBot.write(`Alt text for images on this page is updated! Moving on...`);
      } else {
        console.log("No matches on this page")
        codioIDE.coachBot.write(`No images here, let's move on...`);
      }
    }    
    codioIDE.coachBot.write(`All images in this assignment have been processed! 🐣`);
    codioIDE.coachBot.showMenu()
  }
// calling the function immediately by passing the required variables
})(window.codioIDE, window)
