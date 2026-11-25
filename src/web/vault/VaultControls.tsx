import type { SVGProps } from 'react';
import { Button, Dropdown, Label, Tooltip } from '@heroui/react';
import { EllipsisVertical } from '@gravity-ui/icons';

export type GravityIcon = (props: SVGProps<SVGSVGElement>) => React.JSX.Element;

export async function copyVaultPath(path: string, showError: (message: string) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
  } catch {
    showError('Не удалось скопировать путь к файлу.');
  }
}

export function IconButton({ label, icon: Icon, onPress, disabled = false, className = '' }: {
  readonly label: string;
  readonly icon: GravityIcon;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
  readonly className?: string;
}): React.JSX.Element {
  return <Tooltip delay={300}>
    <Button aria-label={label} className={`vault-icon-button ${className}`} isDisabled={disabled} variant="ghost" onPress={onPress}>
      <Icon aria-hidden="true" />
    </Button>
    <Tooltip.Content>{label}</Tooltip.Content>
  </Tooltip>;
}

export interface VaultMenuAction {
  readonly id: string;
  readonly label: string;
  readonly icon?: GravityIcon;
  readonly danger?: boolean;
}

export function VaultMenu({ label, actions, onAction, triggerIcon = EllipsisVertical, className = '' }: {
  readonly label: string;
  readonly actions: readonly VaultMenuAction[];
  readonly onAction: (id: string) => void;
  readonly triggerIcon?: GravityIcon;
  readonly className?: string;
}): React.JSX.Element {
  const Trigger = triggerIcon;
  return <Dropdown>
    <Tooltip delay={300}>
      <Dropdown.Trigger aria-label={label} className={`vault-icon-button ${className}`}>
        <Trigger aria-hidden="true" />
      </Dropdown.Trigger>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
    <Dropdown.Popover placement="bottom end">
      <Dropdown.Menu aria-label={label} onAction={(key) => onAction(key.toString())}>
        {actions.map((action) => {
          const Icon = action.icon;
          return <Dropdown.Item id={action.id} key={action.id} textValue={action.label} variant={action.danger ? 'danger' : 'default'}>
            {Icon && <Icon aria-hidden="true" />}<Label>{action.label}</Label>
          </Dropdown.Item>;
        })}
      </Dropdown.Menu>
    </Dropdown.Popover>
  </Dropdown>;
}
