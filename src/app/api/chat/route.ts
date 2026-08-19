export const dynamic = "force-dynamic";

interface Source {
  title: string;
  url: string;
  snippet: string;
}

interface DdgResponse {
  Abstract?: string;
  AbstractURL?: string;
  AbstractSource?: string;
  Infobox?: { content?: Array<Record<string, string>> };
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
}

interface WikiSummaryResponse {
  title?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
}

interface WikiSearchResponse {
  query?: {
    search?: Array<{ title: string; snippet?: string }>;
  };
}

export async function POST(req: Request) {
  const body = await req.json() as { message?: string };
  const message = body.message?.trim();
  if (!message) return Response.json({ error: "Empty message" }, { status: 400 });

  const sources: Source[] = [];
  const answers: string[] = [];

  // 1. DuckDuckGo instant answer
  try {
    const r = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(message)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { "User-Agent": "GigiGivo/1.0" } },
    );
    if (r.ok) {
      const d = await r.json() as DdgResponse;
      if (d.Abstract) {
        answers.push(d.Abstract);
        if (d.AbstractURL)
          sources.push({
            title:   d.AbstractSource ?? "Source",
            url:     d.AbstractURL,
            snippet: d.Abstract.slice(0, 200),
          });
      }
      if (d.Infobox?.content?.length) {
        answers.push(
          d.Infobox.content
            .filter((c) => c.label && c.value)
            .map((c) => `${c.label}: ${c.value}`)
            .join("\n"),
        );
      }
      d.RelatedTopics?.slice(0, 4).forEach((t) => {
        if (t.Text && t.FirstURL)
          sources.push({
            title:   t.Text.slice(0, 60),
            url:     t.FirstURL,
            snippet: t.Text.slice(0, 150),
          });
      });
    }
  } catch { /* skip */ }

  // 2. Wikipedia page summary
  try {
    const r = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(message.replace(/ /g, "_"))}`,
      { headers: { "User-Agent": "GigiGivo/1.0" } },
    );
    if (r.ok) {
      const d = await r.json() as WikiSummaryResponse;
      if (d.extract && d.extract.length > 30) {
        answers.push(d.extract);
        sources.push({
          title:   d.title ?? message,
          url:     d.content_urls?.desktop?.page ?? "",
          snippet: d.extract.slice(0, 150),
        });
      }
    }
  } catch { /* skip */ }

  // 3. DuckDuckGo HTML search for broader results
  try {
    const r = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(message + " football soccer")}`,
      { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } },
    );
    if (r.ok) {
      const html = await r.text();
      const snippetRe = /class="result__snippet">([^<]+)/g;
      let m: RegExpExecArray | null;
      while ((m = snippetRe.exec(html)) !== null) {
        const clean = m[1]
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .trim();
        if (clean.length > 30 && answers.length < 5) answers.push(clean);
      }
      const urlRe = /class="result__a" href="([^"]*)"[^>]*>([^<]*)/g;
      while ((m = urlRe.exec(html)) !== null) {
        const url = decodeURIComponent(m[1].replace(/.*uddg=/, "").split("&")[0]);
        if (url.startsWith("http") && sources.length < 8)
          sources.push({ title: m[2].trim(), url, snippet: "" });
      }
    }
  } catch { /* skip */ }

  // 4. Wikipedia search as final fallback
  if (answers.length === 0) {
    try {
      const r = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(message)}&format=json&srlimit=3`,
        { headers: { "User-Agent": "GigiGivo/1.0" } },
      );
      if (r.ok) {
        const d = await r.json() as WikiSearchResponse;
        (d.query?.search ?? []).forEach((sr) => {
          const snippet = sr.snippet?.replace(/<[^>]*>/g, "").trim();
          if (snippet) answers.push(`${sr.title}: ${snippet}`);
          sources.push({
            title:   sr.title,
            url:     `https://en.wikipedia.org/wiki/${encodeURIComponent(sr.title)}`,
            snippet: snippet?.slice(0, 100) ?? "",
          });
        });
      }
    } catch { /* skip */ }
  }

  // Synthesise final answer
  let answer: string;
  if (answers.length > 0) {
    const unique = [...new Set(answers)];
    answer = unique.slice(0, 3).join("\n\n");
  } else if (sources.length > 0) {
    answer =
      "Here's what I found:\n\n" +
      sources
        .slice(0, 5)
        .map((s, i) => `${i + 1}. ${s.title}`)
        .join("\n");
  } else {
    answer = `I couldn't find results for "${message}". Try a more specific question like "Mbappe goals 2026" or "Premier League top scorers".`;
  }

  // Deduplicate sources by URL
  const seenUrls = new Set<string>();
  const uniqueSources = sources
    .filter((s) => {
      if (seenUrls.has(s.url)) return false;
      seenUrls.add(s.url);
      return true;
    })
    .slice(0, 6);

  return Response.json({ answer, sources: uniqueSources, query: message });
}
