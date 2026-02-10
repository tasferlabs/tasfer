/**
 * Service Worker Bridge
 *
 * Provides a way for the VersionContext to communicate with
 * the service worker registration without circular imports.
 */

type UpdateCallback = () => void;
type ActivatorCallback = () => void;

let onServiceWorkerUpdate: UpdateCallback | null = null;
let activateServiceWorker: ActivatorCallback | null = null;

export const serviceWorkerBridge = {
  /** Register callback for when service worker has an update ready */
  setOnUpdate: (callback: UpdateCallback) => {
    onServiceWorkerUpdate = callback;
  },

  /** Trigger the update callback (called from main.tsx) */
  triggerUpdate: () => {
    if (onServiceWorkerUpdate) {
      onServiceWorkerUpdate();
    }
  },

  /** Store the activator function (called from main.tsx) */
  setActivator: (callback: ActivatorCallback) => {
    activateServiceWorker = callback;
  },

  /** Get the activator function to skip waiting */
  getActivator: () => activateServiceWorker,
};
