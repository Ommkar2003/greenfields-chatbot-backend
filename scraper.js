import axios from "axios";
import * as cheerio from "cheerio";
import https from "https";

const agent = new https.Agent({ family: 4 });

export async function readPage(url) {
  try {
    const { data } = await axios.get(url, {
      httpsAgent: agent,
      timeout: 15000
    });

    const $ = cheerio.load(data);
    $("script, style, nav, footer, header, noscript").remove();

    const text = $("body").text();
    return text.replace(/\s+/g, " ").trim();

  } catch (err) {
    console.error("❌ Scrape failed:", url, err.message);
    return "";
  }
}
