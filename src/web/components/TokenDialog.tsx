/** Диалог bearer-токена с HeroUI-полем и управлением фокусом модального окна. */
import { useState } from 'react';
import { Button, Input, Label, Modal, TextField } from '@heroui/react';

interface TokenDialogProps {
  onConfirm(token: string): void;
}

export function TokenDialog({ onConfirm }: TokenDialogProps): React.JSX.Element {
  const [value, setValue] = useState('');
  return (
    <Modal.Backdrop isOpen isDismissable={false}>
      <Modal.Container>
        <Modal.Dialog aria-label="LiveNote защищён токеном">
          <Modal.Header><Modal.Heading>LiveNote защищён токеном</Modal.Heading></Modal.Header>
          <Modal.Body>
            <p className="modal__text">Сервер требует bearer-токен. Он сохранится только в локальном хранилище этого браузера.</p>
            <TextField fullWidth autoFocus type="password" value={value} onChange={setValue}>
              <Label>Токен</Label>
              <Input aria-label="Bearer-токен" autoComplete="off" onKeyDown={(event) => {
                if (event.key === 'Enter' && value.trim()) onConfirm(value.trim());
              }} />
            </TextField>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="primary" isDisabled={!value.trim()} onPress={() => onConfirm(value.trim())}>Открыть</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
