import React, { createContext, useContext, useState } from 'react';

interface SavingContextType {
  isSaving: boolean;
  setIsSaving: (isSaving: boolean) => void;
}

const SavingContext = createContext<SavingContextType | undefined>(undefined);

export function SavingProvider({ children }: { children: React.ReactNode }) {
  const [isSaving, setIsSaving] = useState(false);

  return (
    <SavingContext.Provider value={{ isSaving, setIsSaving }}>
      {children}
    </SavingContext.Provider>
  );
}

export function useSaving() {
  const context = useContext(SavingContext);
  if (context === undefined) {
    throw new Error('useSaving must be used within a SavingProvider');
  }
  return context;
}

