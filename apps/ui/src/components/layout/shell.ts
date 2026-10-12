import { createContext, useContext } from 'react';

export interface ShellApi {
  openNewChannel: () => void;
  /** Opens the agents' computer files in a drawer. */
  openFiles: () => void;
  /** Desktop: toggles the live computer side panel. Mobile: goes to /computer. */
  toggleComputer: () => void;
  computerOpen: boolean;
}

export const ShellContext = createContext<ShellApi>({
  openNewChannel: () => {},
  openFiles: () => {},
  toggleComputer: () => {},
  computerOpen: false,
});

export const useShell = () => useContext(ShellContext);
