/** Настройки интерфейса на доступных HeroUI-контролах. */
import { useState } from 'react';
import { Button, Label, ListBox, Modal, Select, Switch } from '@heroui/react';
import { MERMAID_THEMES } from '../../shared/types';
import type { MermaidTheme } from '../../shared/types';
import { getThemeOverride, setThemeOverride } from '../mermaidInit';

export type PageWidth = 'standard' | 'wide' | 'full';

export const PAGE_WIDTHS: Array<{ value: PageWidth; label: string }> = [
  { value: 'standard', label: 'Обычная' },
  { value: 'wide', label: 'Широкая' },
  { value: 'full', label: 'На всю' }
];

const THEME_OPTIONS: Array<{ value: MermaidTheme | ''; label: string }> = [
  { value: '', label: 'Как на сервере' },
  ...MERMAID_THEMES.map((theme) => ({ value: theme, label: theme }))
];

interface SettingsDialogProps {
  pageWidth: PageWidth;
  onPageWidthChange(width: PageWidth): void;
  followEvents: boolean;
  onFollowChange(follow: boolean): void;
  vimEnabled?: boolean;
  onVimEnabledChange?: (enabled: boolean) => void;
  onClose(): void;
}

export function SettingsDialog(props: SettingsDialogProps): React.JSX.Element {
  const [theme, setTheme] = useState<string>(() => getThemeOverride() ?? '');
  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <Modal.Container>
        <Modal.Dialog aria-label="Настройки">
          <Modal.Header><Modal.Heading>Настройки</Modal.Heading><Modal.CloseTrigger aria-label="Закрыть настройки" /></Modal.Header>
          <Modal.Body>
            <div className="vault-dialog-fields">
              <Select value={theme} onChange={(value) => {
                const next = String(value ?? '');
                setTheme(next);
                setThemeOverride(next === '' ? null : next as MermaidTheme);
              }}>
                <Label>Тема Mermaid</Label>
                <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                <Select.Popover><ListBox>
                  {THEME_OPTIONS.map((option) => (
                    <ListBox.Item key={option.value || 'server'} id={option.value} textValue={option.label}>
                      {option.label}<ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox></Select.Popover>
              </Select>
              <Select value={props.pageWidth} onChange={(value) => props.onPageWidthChange(String(value) as PageWidth)}>
                <Label>Ширина страницы</Label>
                <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                <Select.Popover><ListBox>
                  {PAGE_WIDTHS.map((option) => (
                    <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                      {option.label}<ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox></Select.Popover>
              </Select>
              <Switch isSelected={props.vimEnabled ?? false} onChange={props.onVimEnabledChange}>
                <Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control><Label>Vim mode</Label></Switch.Content>
              </Switch>
              <Switch isSelected={props.followEvents} onChange={props.onFollowChange}>
                <Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control><Label>Следовать за изменениями</Label></Switch.Content>
              </Switch>
            </div>
          </Modal.Body>
          <Modal.Footer><Button variant="primary" onPress={props.onClose}>Готово</Button></Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
