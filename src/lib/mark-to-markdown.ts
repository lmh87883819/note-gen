import { Mark } from "@/db/marks";

/**
 * Convert a Mark record to markdown format based on its type
 */
export function markToMarkdown(mark: Mark): string {
  switch (mark.type) {
    case 'text':
      // Text: insert content directly
      return mark.content || '';
    
    case 'image':
      // Image: insert as markdown image with description
      const imageDesc = mark.desc || 'image';
      return `![${imageDesc}](${mark.url})`;
    
    case 'link':
      // Link: insert as markdown link with description
      const linkDesc = mark.desc || mark.url;
      return `[${linkDesc}](${mark.url})`;
    
    case 'file':
      // File: insert as markdown link with filename
      const fileName = mark.desc || 'file';
      return `[${fileName}](${mark.url})`;
    
    default:
      return mark.content || '';
  }
}
