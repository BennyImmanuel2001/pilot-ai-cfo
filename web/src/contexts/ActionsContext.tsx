import { createContext, useContext } from 'react';
import type { ActionState } from '../hooks/useChat';

export interface ActionsApi {
  actions: Record<string, ActionState>;
  approve: (id: string) => void;
  decline: (id: string) => void;
  capture: (id: string, orderId: string) => void;
}

export const ActionsContext = createContext<ActionsApi>({
  actions: {},
  approve: () => {},
  decline: () => {},
  capture: () => {},
});

export const useActions = () => useContext(ActionsContext);
