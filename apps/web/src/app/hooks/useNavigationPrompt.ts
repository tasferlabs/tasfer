import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Hook to prompt user before navigation when a condition is met
 * Works by intercepting clicks on links within the app
 * @param when - Condition to check before allowing navigation
 * @param getConfirmation - Function to get user confirmation
 */
export function useNavigationPrompt(
  when: boolean,
  getConfirmation: (options: {
    title: string;
    description: string;
    cancelText?: string;
    confirmText?: string;
  }) => Promise<boolean>
) {
  const location = useLocation();
  const currentPath = useRef(location.pathname);
  const isNavigating = useRef(false);

  useEffect(() => {
    currentPath.current = location.pathname;
  }, [location.pathname]);

  useEffect(() => {
    if (!when) return;

    // Intercept clicks on navigation links
    const handleClick = async (e: MouseEvent) => {
      // Avoid recursive handling
      if (isNavigating.current) return;

      const target = e.target as HTMLElement;
      const link = target.closest('a');
      
      if (!link) return;

      const href = link.getAttribute('href');
      
      // Ignore external links, anchors, and special protocols
      if (!href || 
          href.startsWith('http://') || 
          href.startsWith('https://') || 
          href.startsWith('mailto:') || 
          href.startsWith('tel:') ||
          href.startsWith('#')) {
        return;
      }

      // Check if this would actually navigate to a different page
      const targetPath = href.startsWith('/') ? href : `/${href}`;
      if (targetPath === currentPath.current || targetPath === location.pathname) {
        return;
      }

      // Prevent the default navigation
      e.preventDefault();
      e.stopPropagation();

      isNavigating.current = true;

      try {
        const confirmed = await getConfirmation({
          title: 'Unsaved Changes',
          description: 'Your changes are still being saved. Are you sure you want to leave?',
          cancelText: 'Wait',
          confirmText: 'Leave Anyway',
        });

        if (confirmed) {
          // Temporarily disable the hook and navigate
          isNavigating.current = false;
          // Trigger navigation by simulating the click without this handler
          const newEvent = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
          });
          
          // Remove listener temporarily
          document.removeEventListener('click', handleClick, true);
          link.dispatchEvent(newEvent);
          // Re-add listener after a brief delay
          setTimeout(() => {
            if (when) {
              document.addEventListener('click', handleClick, true);
            }
          }, 0);
        }
      } finally {
        if (!isNavigating.current) {
          isNavigating.current = false;
        }
      }
    };

    // Capture phase to intercept before React Router
    document.addEventListener('click', handleClick, true);
    
    return () => {
      document.removeEventListener('click', handleClick, true);
    };
  }, [when, getConfirmation, location.pathname]);
}

