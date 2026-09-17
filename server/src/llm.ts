// deepseek-v4-flash returns a "thinking" block before the "text" block,
// so always read the first text block instead of content[0]
export function firstText(content: { type: string; text?: string }[]): string {
  return content.find((b) => b.type === "text")?.text?.trim() ?? "";
}
