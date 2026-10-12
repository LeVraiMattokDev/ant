import { useNavigate } from 'react-router-dom';
import { Bot, CalendarClock, Users } from 'lucide-react';
import { MenuItem, Popover, type Placement, type TriggerProps } from '../Popover';
import { useShell } from './shell';

/** "+" menu: new bot, new group channel, new routine. */
export function CreateMenu({ placement, trigger }: { placement: Placement; trigger: (p: TriggerProps) => React.ReactNode }) {
  const navigate = useNavigate();
  const { openNewChannel } = useShell();
  return (
    <Popover label="Créer" placement={placement} trigger={trigger}>
      {(close) => (
        <>
          <MenuItem
            icon={<Bot />}
            onSelect={() => {
              close();
              navigate('/bots/new');
            }}
          >
            Nouveau bot
          </MenuItem>
          <MenuItem
            icon={<Users />}
            onSelect={() => {
              close();
              openNewChannel();
            }}
          >
            Nouveau canal de groupe
          </MenuItem>
          <MenuItem
            icon={<CalendarClock />}
            onSelect={() => {
              close();
              navigate('/routines?new=1');
            }}
          >
            Nouvelle routine
          </MenuItem>
        </>
      )}
    </Popover>
  );
}
