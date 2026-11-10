import { Markdown as MarkdownExtension } from '@tiptap/markdown';
import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useId } from 'react';

/**
 * Markdown, written in a graphical editor (Tiptap) and stored as Markdown.
 * The same renderer shows it read-only, so what you type is what everyone
 * sees. Content goes through the editor's schema, never through innerHTML,
 * so pasted HTML or script can't get in; links only allow http(s) and mailto.
 */
function extensions(placeholder?: string) {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      codeBlock: false,
      code: false,
      horizontalRule: false,
      link: {
        openOnClick: false,
        autolink: true,
        protocols: ['http', 'https', 'mailto'],
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
        isAllowedUri: (url) => /^(https?:|mailto:)/i.test(url),
      },
    }),
    MarkdownExtension,
    ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
  ];
}

type Tool = {
  label: string;
  short: string;
  active: (e: Editor) => boolean;
  run: (e: Editor) => void;
};

const TOOLS: Tool[] = [
  {
    label: 'Bold',
    short: 'B',
    active: (e) => e.isActive('bold'),
    run: (e) => e.chain().focus().toggleBold().run(),
  },
  {
    label: 'Italic',
    short: 'I',
    active: (e) => e.isActive('italic'),
    run: (e) => e.chain().focus().toggleItalic().run(),
  },
  {
    label: 'Heading',
    short: 'H2',
    active: (e) => e.isActive('heading', { level: 2 }),
    run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    label: 'Subheading',
    short: 'H3',
    active: (e) => e.isActive('heading', { level: 3 }),
    run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    label: 'Bulleted list',
    short: '•',
    active: (e) => e.isActive('bulletList'),
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    label: 'Numbered list',
    short: '1.',
    active: (e) => e.isActive('orderedList'),
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    label: 'Quote',
    short: '❝',
    active: (e) => e.isActive('blockquote'),
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
];

function Toolbar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      active: TOOLS.map((t) => t.active(e)),
      link: e.isActive('link'),
    }),
  });
  function link() {
    const prev = (editor.getAttributes('link').href as string | undefined) ?? '';
    // A small inline prompt would be nicer; window.prompt keeps this dependency-free.
    const url = window.prompt('Link address (https://…)', prev);
    if (url === null) return;
    if (!url.trim()) editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
  }
  return (
    <div role="toolbar" aria-label="Formatting" className="md-toolbar">
      {TOOLS.map((t, i) => (
        <button
          key={t.label}
          type="button"
          title={t.label}
          // Include what's on the button ("H2", "1.") so it can be said aloud (WCAG 2.5.3).
          aria-label={/[a-z0-9]/i.test(t.short) ? `${t.short} ${t.label}` : t.label}
          aria-pressed={state.active[i]}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => t.run(editor)}
        >
          {t.short}
        </button>
      ))}
      <button
        type="button"
        title="Link"
        aria-label="Link"
        aria-pressed={state.link}
        onMouseDown={(e) => e.preventDefault()}
        onClick={link}
      >
        Link
      </button>
    </div>
  );
}

/** A labelled Markdown editor. `onChange` receives Markdown. */
export function MarkdownEditor({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  hint,
}: {
  label: string;
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  maxLength?: number;
  hint?: string;
}) {
  const id = useId();
  const editor = useEditor({
    extensions: extensions(placeholder),
    content: value,
    contentType: 'markdown',
    immediatelyRender: true,
    editorProps: {
      attributes: { class: 'md md-input', 'aria-labelledby': id, 'aria-multiline': 'true' },
    },
    onUpdate: ({ editor: e }) => onChange(e.getMarkdown()),
  });
  // Outside changes (e.g. Cancel, or switching stage) replace the content.
  useEffect(() => {
    if (editor && value !== editor.getMarkdown()) {
      editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
    }
  }, [editor, value]);
  const over = maxLength !== undefined && value.length > maxLength;
  return (
    <div className="flex flex-col gap-1.5">
      <span id={id} className="text-[15px] font-bold">
        {label}
      </span>
      <div className={`md-frame ${over ? 'border-destructive' : ''}`}>
        {editor && <Toolbar editor={editor} />}
        <EditorContent editor={editor} />
      </div>
      <span className={`src ${over ? 'text-destructive' : ''}`}>
        {hint ?? 'Formatting: bold, italic, headings, lists, quotes and links.'}
        {maxLength !== undefined && ` · ${value.length}/${maxLength}`}
      </span>
    </div>
  );
}

/** Markdown shown read-only, through the same renderer as the editor. */
export function MarkdownView({ value, className = '' }: { value: string; className?: string }) {
  const editor = useEditor({
    extensions: extensions(),
    content: value,
    contentType: 'markdown',
    editable: false,
    immediatelyRender: true,
    // Read-only text, not an input: without this, screen readers announce an
    // unlabelled text box (Phase 6 accessibility audit).
    editorProps: { attributes: { class: `md ${className}`, role: 'document' } },
  });
  useEffect(() => {
    if (editor && value !== editor.getMarkdown()) {
      editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
    }
  }, [editor, value]);
  return <EditorContent editor={editor} />;
}
