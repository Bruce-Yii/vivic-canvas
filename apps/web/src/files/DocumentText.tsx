import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";

/** Source text only: no embedded HTML or automatic remote media. */
export function DocumentText({ text, markdown = false }: { text: string; markdown?: boolean }) {
  const [limit, setLimit] = useState(40_000), value = text.slice(0, limit);
  return <>
    {markdown ? <div className="vivic-document-prose"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
      img: ({ alt }) => <span className="vivic-document-media">图片 · {alt || "嵌入图片"}</span>,
      a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    }}>{value}</ReactMarkdown></div> : <div className="vivic-document-prose vivic-document-plain">{value}</div>}
    {text.length > limit && <Button variant="ghost" size="sm" className="vivic-document-more" onClick={() => setLimit(v => v + 40_000)}>继续阅读</Button>}
  </>;
}
