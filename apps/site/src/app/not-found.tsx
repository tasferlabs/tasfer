import "@/styles/globals.css";
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "./NotFoundPage.css";

import { APP_OPEN_URL } from "@/lib/appUrl";
import { getDictionary } from "@/lib/i18n/locales";
import { ThemeProvider } from "@/providers/ThemeProvider";

export default function NotFound() {
  const dictionary = getDictionary("en");

  return (
    <ThemeProvider>
      <main className="not-found-page">
        <div className="not-found-page__content">
          <div className="not-found-page__copy">
            <h1 className="not-found-page__title">
              {dictionary["notFound.title"]}
            </h1>
            <p className="not-found-page__body">
              {dictionary["notFound.body"]}
            </p>
          </div>

          <div className="not-found-page__actions">
            <a className="not-found-page__app-link" href={APP_OPEN_URL}>
              {dictionary["docs.nav.openApp"]}
            </a>
          </div>
        </div>
      </main>
    </ThemeProvider>
  );
}
