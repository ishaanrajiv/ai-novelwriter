export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function formatLocalTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}_${hour}-${minute}-${second}`;
}

export function createProjectId(bookTitle: string, now: Date = new Date()): string {
  const slug = slugify(bookTitle) || "untitled-book";
  return `${formatLocalTimestamp(now)}_${slug}`;
}

export function chapterKey(chapterNumber: number): string {
  return `ch-${String(chapterNumber).padStart(3, "0")}`;
}

export function blockKey(blockNumber: number): string {
  return `block-${String(blockNumber).padStart(3, "0")}`;
}
