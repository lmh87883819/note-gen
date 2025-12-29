import Vditor from 'vditor'
import Continue from "./continue"
import Translation from "./translation"

export default function CustomToolbar({editor}: {editor?: Vditor}) {
  return <div className="h-12 w-full border-b items-center px-2 gap-1 justify-between hidden">
    <Continue editor={editor} />
    <Translation editor={editor} />
  </div>
}
