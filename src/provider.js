/// <reference path="../types/manga-provider.d.ts" />

// Bridge Seanime -> Suwayomi-Server (runs Tachiyomi/Mihon extensions on the JVM).
// Every Mihon repo/extension installed in Suwayomi becomes searchable from Seanime.

class Provider {
  constructor() {
    this.serverUrl = "{{serverUrl}}".trim().replace(/\/+$/, "") || "http://127.0.0.1:4567";
    this.sourcesSetting = "{{sources}}".trim();
    this.langSetting = "{{languages}}".trim();
    this.maxSources = parseInt("{{maxSources}}", 10) || 5;
    this.username = "{{username}}".trim();
    this.password = "{{password}}";
    this.multiScanlator = "{{multiScanlator}}" === "true";
    this.statsPerSource = 4; // results per source that get chapter counts
    // Set by the Suwayomi Launcher when it generates a provider for a single source.
    const fixed = "__FIXED_SOURCE__";
    this.fixedSource = fixed.startsWith("__") ? "" : fixed;
    this.sourceCache = null;
    this.sourceCacheAt = 0;
    this.token = null; // JWT, only in Suwayomi's ui_login mode
  }

  getSettings() {
    return {
      supportsMultiLanguage: false,
      supportsMultiScanlator: this.multiScanlator,
    };
  }

  // ---------------------------------------------------------------- helpers

  authHeaders() {
    if (!this.username) return {};
    const raw = `${this.username}:${this.password}`;
    const b64 = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(raw));
    return { Authorization: `Basic ${b64}` };
  }

  absUrl(path) {
    if (!path) return undefined;
    if (/^https?:\/\//i.test(path)) return path;
    return this.serverUrl + (path.startsWith("/") ? "" : "/") + path;
  }

  // ui_login mode (Suwayomi multi-user) ignores Basic auth on the GraphQL API: log in for a JWT.
  async login() {
    const data = await this.post(
      "mutation($u: String!, $p: String!) { login(input: { username: $u, password: $p }) { accessToken } }",
      { u: this.username, p: this.password }, {});
    if (data.unauthorized) throw new Error(`Suwayomi login refused (${this.serverUrl})`);
    this.token = data.login.accessToken;
  }

  async post(query, variables, auth) {
    let res;
    try {
      res = await fetch(`${this.serverUrl}/api/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...auth },
        body: JSON.stringify({ query, variables: variables || {} }),
      });
    } catch (e) {
      throw new Error(`Suwayomi is not reachable at ${this.serverUrl} — is the "Suwayomi Launcher" plugin running? (${e})`);
    }
    // Seanime's runtime may return json() synchronously, so no .catch() chaining here.
    let json = null;
    if (res.status !== 401) {
      try { json = await res.json(); } catch (e) { json = null; }
    }
    if (res.status === 401 || (json && json.errors && json.errors.some(e => /unauthori[sz]ed/i.test(e.message)))) {
      return { unauthorized: true };
    }
    if (!res.ok || !json) throw new Error(`Suwayomi HTTP ${res.status} (${this.serverUrl})`);
    if (json.errors && json.errors.length) {
      throw new Error("Suwayomi: " + json.errors.map(e => e.message).join("; "));
    }
    return json.data;
  }

  async gql(query, variables) {
    const auth = () => (this.token ? { Authorization: `Bearer ${this.token}` } : this.authHeaders());
    let data = await this.post(query, variables, auth());
    // Access tokens are short-lived (server.jwtTokenExpiry, 5 min by default): log in again once.
    if (data.unauthorized && this.username) {
      this.token = null;
      await this.login();
      data = await this.post(query, variables, auth());
    }
    if (data.unauthorized) throw new Error(`Suwayomi HTTP 401 (${this.serverUrl}): set the username and password`);
    return data;
  }

  splitList(s) {
    return s.split(",").map(x => x.trim()).filter(x => x.length > 0);
  }

  // Resolves the Suwayomi sources to search, in priority order.
  async getSources() {
    // Short cache so extensions installed from the tray show up quickly.
    if (this.sourceCache && Date.now() - this.sourceCacheAt < 60000) return this.sourceCache;

    const data = await this.gql(`query { sources { nodes { id name lang displayName extension { pkgName } } } }`);
    // Skip the Local source ("0") and the "Suwayomi" extension, which only points back at a Suwayomi server.
    const all = (data?.sources?.nodes || []).filter(s =>
      s.id !== "0" && !((s.extension && s.extension.pkgName) || "").endsWith(".tachidesk"));

    let picked = [];
    if (this.fixedSource) {
      this.sourceCache = all.filter(s => s.id === this.fixedSource);
      this.sourceCacheAt = Date.now();
      if (!this.sourceCache.length) throw new Error("This source is no longer installed in Suwayomi");
      return this.sourceCache;
    } else if (this.sourcesSetting) {
      // Accept source IDs, names ("MangaDex") or display names ("MangaDex (EN)").
      for (const want of this.splitList(this.sourcesSetting)) {
        const w = want.toLowerCase();
        const matches = all.filter(s =>
          s.id === want || s.displayName.toLowerCase() === w || s.name.toLowerCase() === w,
        );
        for (const m of matches) if (!picked.some(p => p.id === m.id)) picked.push(m);
      }
    } else {
      picked = all;
    }

    if (this.langSetting) {
      const langs = this.splitList(this.langSetting).map(l => l.toLowerCase());
      picked = picked.filter(s => langs.includes(s.lang.toLowerCase()) || s.lang === "all");
    }

    this.sourceCache = picked.slice(0, this.maxSources);
    this.sourceCacheAt = Date.now();
    if (!this.sourceCache.length) {
      console.warn("[suwayomi] no matching sources; install extensions in Suwayomi or fix the 'sources'/'languages' settings");
    }
    return this.sourceCache;
  }

  // ---------------------------------------------------------------- provider API

  // Rough title similarity (Dice over word bigrams) used to pick which results get chapter stats.
  similarity(a, b) {
    const grams = s => {
      const t = ` ${s.toLowerCase().replace(/[^a-z0-9À-￿]+/g, " ").trim()} `;
      const out = [];
      for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
      return out;
    };
    const x = grams(a), y = grams(b);
    if (!x.length || !y.length) return 0;
    const pool = y.slice();
    let hit = 0;
    for (const g of x) {
      const k = pool.indexOf(g);
      if (k >= 0) { hit++; pool.splice(k, 1); }
    }
    return (2 * hit) / (x.length + y.length);
  }

  // Distinct chapter numbers and the latest chapter of a Suwayomi manga.
  async chapterStats(mangaId) {
    const data = await this.gql(`mutation($input: FetchChaptersInput!) {
      fetchChapters(input: $input) { chapters { chapterNumber } }
    }`, { input: { mangaId: parseInt(mangaId, 10) } });
    const nums = (data?.fetchChapters?.chapters || []).map(c => c.chapterNumber).filter(n => n >= 0);
    if (!nums.length) return null;
    return { distinct: new Set(nums).size, latest: Math.max(...nums) };
  }

  async search(opts) {
    const sources = await this.getSources();
    const mutation = `mutation($input: FetchSourceMangaInput!) {
      fetchSourceManga(input: $input) { mangas { id title thumbnailUrl } }
    }`;

    const perSource = await Promise.all(sources.map(async src => {
      try {
        const data = await this.gql(mutation, {
          input: { source: src.id, type: "SEARCH", page: 1, query: opts.query },
        });
        return (data?.fetchSourceManga?.mangas || []).map(m => ({ m, src }));
      } catch (e) {
        console.warn(`[suwayomi] search failed on ${src.displayName}: ${e}`);
        return [];
      }
    }));

    // Chapter stats need a chapter fetch per result, so only do it for the closest
    // matches of each source, all in parallel.
    const stats = new Map();
    const picks = perSource.flatMap(list => list
      .map(r => ({ id: r.m.id, score: this.similarity(r.m.title, opts.query) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.statsPerSource));
    await Promise.all(picks.map(async p => {
      try {
        const s = await this.chapterStats(p.id);
        if (s) stats.set(p.id, s);
      } catch (e) {
        console.warn(`[suwayomi] chapter stats failed for manga ${p.id}: ${e}`);
      }
    }));

    // The card in Manual match only shows the title, so the source and chapter stats go in
    // front of it. The plain title stays in synonyms, which Seanime uses for auto-matching.
    // Sources are in priority order, so earlier sources win on ties.
    return perSource.flat().map(({ m, src }) => {
      const s = stats.get(m.id);
      // Single-source providers already carry the source in their name.
      const parts = this.fixedSource ? [] : [src.displayName];
      if (s) parts.push(`${s.distinct} ch`, `latest ${s.latest}`);
      return {
        id: String(m.id),
        title: parts.length ? `[${parts.join(" · ")}] ${m.title}` : m.title,
        synonyms: [m.title],
        image: this.absUrl(m.thumbnailUrl),
      };
    });
  }

  async findChapters(mangaId) {
    const id = parseInt(mangaId, 10);
    const [data, info] = await Promise.all([
      this.gql(`mutation($input: FetchChaptersInput!) {
        fetchChapters(input: $input) {
          chapters { id name chapterNumber scanlator uploadDate sourceOrder realUrl }
        }
      }`, { input: { mangaId: id } }),
      this.gql(`query($id: Int!) { manga(id: $id) { source { displayName } } }`, { id }).catch(() => null),
    ]);
    // Show which Mihon source the chapters come from, e.g. "Chapter 12 · VoraToon (ID)".
    const sourceName = this.fixedSource ? "" : info?.manga?.source?.displayName || "";

    const chapters = data?.fetchChapters?.chapters || [];

    // sourceOrder is 0 for the newest chapter; reverse it to get reading order.
    chapters.sort((a, b) => {
      const an = a.chapterNumber, bn = b.chapterNumber;
      if (an >= 0 && bn >= 0 && an !== bn) return an - bn;
      return b.sourceOrder - a.sourceOrder;
    });

    return chapters.map((c, i) => {
      const num = c.chapterNumber >= 0 ? String(c.chapterNumber) : String(i + 1);
      const ts = parseInt(c.uploadDate, 10);
      const ch = {
        id: String(c.id),
        url: c.realUrl || "",
        title: (c.name || `Chapter ${num}`) + (sourceName ? ` · ${sourceName}` : ""),
        chapter: num,
        index: i,
      };
      if (ts > 0) ch.updatedAt = new Date(ts).toISOString();
      if (this.multiScanlator) ch.scanlator = c.scanlator || "Unknown";
      return ch;
    });
  }

  async findChapterPages(chapterId) {
    const data = await this.gql(`mutation($input: FetchChapterPagesInput!) {
      fetchChapterPages(input: $input) { pages }
    }`, { input: { chapterId: parseInt(chapterId, 10) } });

    const pages = data?.fetchChapterPages?.pages || [];
    if (!pages.length) throw new Error("Suwayomi returned no pages for this chapter");

    // Non-empty headers make Seanime load pages through its own image proxy. The reader in the
    // browser can't reach 127.0.0.1:4567 directly, but the Seanime server can.
    const headers = { Accept: "image/*", ...this.authHeaders() };
    // In ui_login mode the page endpoint accepts Basic auth (admin only) when opds=true; access
    // tokens expire in minutes, too soon for a long chapter.
    const suffix = this.token ? (p => (p.includes("?") ? "&" : "?") + "opds=true") : () => "";
    return pages.map((p, index) => ({ url: this.absUrl(p) + suffix(p), index, headers }));
  }
}
