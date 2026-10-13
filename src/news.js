import fs from 'node:fs/promises';

export class NewsService {
  constructor(file) {
    this.file = file;
    this.content = null;
  }

  async init() {
    this.content = await this.read();
    return this;
  }

  async read() {
    const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
    for (const type of ['battleroyalenews', 'stwnews']) {
      if (!value[type] || !Array.isArray(value[type].motds)) throw new Error(`Invalid news config: ${type}.motds must be an array`);
    }
    if (!Array.isArray(value.banners)) value.banners = [];
    return value;
  }

  async reload() {
    this.content = await this.read();
    return this.content;
  }

  getAll() {
    return structuredClone(this.content);
  }

  getNews(mode = 'br') {
    const content = this.getAll();
    const isStw = String(mode).toLowerCase().includes('stw') || String(mode).toLowerCase().includes('save');
    const key = isStw ? 'stwnews' : 'battleroyalenews';
    const news = structuredClone(content[key]);
    news.motds = news.motds.filter((motd) => !motd.hidden).sort((left, right) => Number(left.sortingPriority ?? 0) - Number(right.sortingPriority ?? 0));
    return {
      emergencyNotice: content.emergencyNotice ?? '',
      news,
      [key]: structuredClone(news),
      banners: content.banners.filter((banner) => !banner.hidden && (!banner.mode || banner.mode === (isStw ? 'stw' : 'br'))).sort((left, right) => Number(left.sortingPriority ?? 0) - Number(right.sortingPriority ?? 0))
    };
  }

  fortniteContent() {
    const content = this.getAll();
    return {
      emergencyNotice: { state: 'active', message: { title: '', body: content.emergencyNotice ?? '', hidden: !content.emergencyNotice } },
      battleroyalenews: structuredClone(content.battleroyalenews),
      stwnews: structuredClone(content.stwnews),
      banners: structuredClone(content.banners)
    };
  }
}
