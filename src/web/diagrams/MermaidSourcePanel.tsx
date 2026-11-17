import { useId } from 'react';
import { TextArea } from '@heroui/react';
import type { DiagramEditor } from '../components/useDiagramEditor';

export function MermaidSourcePanel({ editor }: { readonly editor: DiagramEditor }): React.JSX.Element {
  const id = useId();
  return <aside className="flowchart-editor mermaid-source-editor" aria-label="Редактор исходника Mermaid">
    <label htmlFor={id}>Исходник Mermaid</label>
    <p>Изменения сразу отображаются на схеме.</p>
    <TextArea id={id} className="mermaid-source-editor__input" value={editor.source}
      onChange={(event) => editor.editSource(event.target.value)} disabled={editor.saving}
      spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" />
    {editor.error && <div role="alert" className="diagram-fullscreen__error">{editor.error}</div>}
  </aside>;
}
