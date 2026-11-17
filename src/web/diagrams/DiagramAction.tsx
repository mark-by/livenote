import type { ComponentType, SVGProps } from 'react';
import { Button, Tooltip } from '@heroui/react';

interface DiagramActionProps {
  readonly label: string;
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

/** Одинаковые доступные действия для preview и редакторов. */
export function DiagramAction({ label, icon: Icon, onPress, disabled = false, className }: DiagramActionProps): React.JSX.Element {
  return <Tooltip delay={300}>
    <Button isIconOnly variant="ghost" size="sm" aria-label={label} className={className}
      isDisabled={disabled} onPress={onPress}><Icon aria-hidden="true" /></Button>
    <Tooltip.Content>{label}</Tooltip.Content>
  </Tooltip>;
}
