import { useState } from 'react';
import { Button, Popover } from '@heroui/react';
import { Link } from '@gravity-ui/icons';
import type { VaultDocument } from '../../shared/types';
import type { EditorVimMode } from '../editor/LivePreviewEditor';

const vimLabels: Record<EditorVimMode, string> = { normal: 'Normal', insert: 'Insert', visual: 'Visual' };

export function VaultEditorStatus({ backlinks, vimMode, onNavigate }: {
  readonly backlinks: VaultDocument['backlinks'];
  readonly vimMode: EditorVimMode | undefined;
  readonly onNavigate: (path: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <div className="vault-editor-status" role="group" aria-label="Состояние активного редактора">
    {vimMode && <span role="status">Vim · {vimLabels[vimMode]}</span>}
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button size="sm" variant="ghost" className="vault-editor-status__backlinks"
        aria-label={`Связанные заметки: ${backlinks.length}`}>
        <Link aria-hidden="true" />{backlinks.length}
      </Button>
      <Popover.Content placement="top end" className="vault-backlinks-popover">
        <Popover.Dialog aria-label="Связанные заметки">
          <Popover.Heading>Связанные заметки</Popover.Heading>
          {backlinks.length === 0 ? <p>На эту заметку пока никто не ссылается.</p>
            : <div className="vault-backlinks__list">{backlinks.map(backlink =>
              <Button key={backlink.pageId} variant="ghost" onPress={() => {
                setOpen(false);
                onNavigate(backlink.pageId);
              }}>
                <span>{backlink.title}</span><small>{backlink.path}</small>
              </Button>
            )}</div>}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  </div>;
}
