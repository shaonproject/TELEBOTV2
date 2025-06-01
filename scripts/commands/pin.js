const axios = require("axios");
const path = require("path");
const fs = require("fs");

const meta = {
  name: "pic",
  version: "0.0.1",
  aliases: ["pin"],
  description: "This command allows you to search for images on Pinterest based on a given query and fetch a specified number of images (1-20).",
  author: "ArYAN",
  prefix: true,
  category: "media",
  type: "anyone",
  cooldown: 20,
  guide: "{pn} <search query> - <number of images>\nExample: {pn} cat - 10"
};

async function onStart({ bot, message, msg, args, chatId, usages }) {
  try {
    const keySearch = args.join(" ");

    if (!keySearch.includes("-")) {
      return usages();
    }

    const [searchQuery, numImagesStr] = keySearch.split("-").map(s => s.trim());
    let numberSearch = parseInt(numImagesStr);

    if (!searchQuery) {
      return message.reply("Please provide a search query.");
    }

    if (isNaN(numberSearch) || numberSearch < 1) {
      numberSearch = 6;
    }
    if (numberSearch > 20) {
      numberSearch = 20;
      await message.reply("Limiting the number of images to 20 to prevent overload.");
    }

    const apiUrl = `https://xyz-naruto-api.onrender.com/pinterest?search=${encodeURIComponent(searchQuery)}&count=${numberSearch}`;

    const res = await axios.get(apiUrl);
    const data = res.data.data;

    if (!data || data.length === 0) {
      return message.reply(`No images found for "${searchQuery}".`);
    }

    const imgData = [];
    const cacheDir = path.join(__dirname, "cache", msg.message_id.toString());
    
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const downloadPromises = [];
    for (let i = 0; i < Math.min(numberSearch, data.length); i++) {
      const imageUrl = data[i];
      const imgPath = path.join(cacheDir, `${i + 1}.jpg`);
      downloadPromises.push(
        axios.get(imageUrl, {
          responseType: "arraybuffer",
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        })
        .then(imgResponse => fs.promises.writeFile(imgPath, imgResponse.data, 'binary'))
        .then(() => imgData.push(imgPath))
        .catch(error => console.error(`Error downloading image ${imageUrl}:`, error.message))
      );
    }
    await Promise.allSettled(downloadPromises);

    if (imgData.length === 0) {
      return message.reply("Failed to download any images. Please try again later.");
    }

    const mediaAttachments = imgData.map(imgPath => ({
        type: 'photo',
        media: fs.createReadStream(imgPath),
    }));

    await bot.sendMediaGroup(chatId, mediaAttachments, {
      caption: `Here are ${imgData.length} Pinterest results for "${searchQuery}"`,
      reply_to_message_id: msg.message_id
    });

  } catch (error) {
    console.error(`Error in Pinterest command:`, error);
    return message.reply(`An error occurred while fetching images: ${error.message}`);
  } finally {
    const currentCacheDir = path.join(__dirname, "cache", msg.message_id.toString());
    if (fs.existsSync(currentCacheDir)) {
      await fs.promises.rm(currentCacheDir, { recursive: true, force: true }).catch(console.error);
    }
  }
}

module.exports = { meta, onStart };
