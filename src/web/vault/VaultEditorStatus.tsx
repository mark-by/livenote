import { useState } from 'react';
import { Button, Popover, ToggleButton, Tooltip } from '@heroui/react';
import { Comment, CommentFill, Link } from '@gravity-ui/icons';
import type { VaultDocument } from '../../shared/types';
import type { EditorVimMode } from '../editor/LivePreviewEditor';

const vimLabels: Record<EditorVimMode, string> = { normal: 'Normal', insert: 'Insert', visual: 'Visual' };

export interface AgentToggleState {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}

export function VaultEditorStatus({ backlinks, vimMode, onNavigate, agentToggle }: {
  readonly backlinks?: VaultDocument['backlinks'];
  readonly vimMode: EditorVimMode | undefined;
  readonly onNavigate: (path: string) => void;
  readonly agentToggle?: AgentToggleState;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return <div className="vault-editor-status" role="group" aria-label="Состояние активного редактора">
    {vimMode && <span role="status">Vim · {vimLabels[vimMode]}</span>}
    {backlinks && <Popover isOpen={open} onOpenChange={setOpen}>
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
    </Popover>}
    {agentToggle && <Tooltip delay={300}>
      <ToggleButton aria-label="Чат агента" isIconOnly size="sm" variant="ghost"
        isSelected={agentToggle.open} onChange={agentToggle.setOpen}>
        {agentToggle.open ? <CommentFill aria-hidden="true" /> : <Comment aria-hidden="true" />}
      </ToggleButton>
      <Tooltip.Content placement="top end">{agentToggle.open ? 'Скрыть чат агента' : 'Показать чат агента'}</Tooltip.Content>
    </Tooltip>}
  </div>;
}
