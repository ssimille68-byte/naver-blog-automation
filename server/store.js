import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ensureDirs } from './util/paths.js';

ensureDirs();

/** Write via a temp file + rename so a crash can never leave half a JSON file. */
function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export const DEFAULT_SETTINGS = {
  interests: ['IT 신기술'],
  blogId: '',
  model: 'sonnet',
  visionModel: 'sonnet',
  topicCount: 6,
  sourcesPerTopic: 5,
  newsPerKeyword: 10,
  blogsPerKeyword: 10,
  imagesPerPost: 3,
  imageCandidates: 5,
  imageMinScore: 70,
  imageSources: ['openverse', 'wikimedia'],
  unsplashAccessKey: '',
  pexelsApiKey: '',
  tone: '친근하고 정보 전달이 명확한 존댓말',
  targetLength: 1800,
  defaultVisibility: 'public',
  defaultCategory: '',
  autoPublish: false,
  headless: true,
  slowMo: 120,
};

class Collection {
  constructor(name, initial) {
    this.file = path.join(DATA_DIR, `${name}.json`);
    this.data = readJson(this.file, initial);
  }

  save() {
    writeAtomic(this.file, this.data);
    return this.data;
  }
}

const settingsStore = new Collection('settings', { ...DEFAULT_SETTINGS });

export const settings = {
  get() {
    // 저장된 설정에 없는 새 키는 기본값으로 채운다 (버전 업그레이드 대비).
    return { ...DEFAULT_SETTINGS, ...settingsStore.data };
  },
  update(patch) {
    settingsStore.data = { ...settings.get(), ...patch };
    settingsStore.save();
    return settings.get();
  },
};

function listStore(name) {
  const store = new Collection(name, []);
  if (!Array.isArray(store.data)) store.data = [];
  return {
    all() {
      return store.data;
    },
    find(id) {
      return store.data.find((item) => item.id === id) || null;
    },
    insert(item) {
      store.data.unshift(item);
      store.save();
      return item;
    },
    update(id, patch) {
      const item = store.data.find((entry) => entry.id === id);
      if (!item) return null;
      Object.assign(item, patch, { updatedAt: new Date().toISOString() });
      store.save();
      return item;
    },
    remove(id) {
      const before = store.data.length;
      store.data = store.data.filter((item) => item.id !== id);
      if (store.data.length !== before) store.save();
      return before !== store.data.length;
    },
    replaceAll(items) {
      store.data = items;
      store.save();
      return items;
    },
    /** Keep the newest `keep` entries so the JSON files stay small. */
    trim(keep) {
      if (store.data.length > keep) {
        store.data = store.data.slice(0, keep);
        store.save();
      }
    },
  };
}

export const topics = listStore('topics');
export const drafts = listStore('drafts');
export const publications = listStore('publications');

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
