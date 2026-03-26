import React from "react";
import { Navigate, createBrowserRouter, createHashRouter, redirect } from "react-router-dom";
import Layout from "../layout/Layout";
import { getClientPlatform } from "@/platform";

/** Guard: only allow /home and /privacy on web platform, redirect others to editor */
function WebOnlyGuard({ children }: { children: React.ReactNode }) {
  if (getClientPlatform() !== "web") {
    return <Navigate to="/page" replace />;
  }
  return <>{children}</>;
}

const EditorPage = React.lazy(() => import("../pages/EditorPage"));
const CalendarPage = React.lazy(
  () => import("../pages/CalendarPage/CalendarPage"),
);
const SettingsPage = React.lazy(
  () => import("../pages/SettingsPage/SettingsPage"),
);
const HomePage = React.lazy(() => import("../pages/HomePage/HomePage"));
const PrivacyPage = React.lazy(
  () => import("../pages/PrivacyPage/PrivacyPage"),
);

const createRouter =
  getClientPlatform() === "web" ? createBrowserRouter : createHashRouter;

export const router = createRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      {
        index: true,
        loader: () => {
          const lastRoute = localStorage.getItem("lastRoute");
          // New user on web → show home page
          if (!lastRoute && getClientPlatform() === "web") {
            return redirect("/home");
          }
          return redirect(lastRoute || "/page");
        },
      },
      {
        path: "page/:id",
        element: <EditorPage />,
      },
      {
        path: "page",
        element: <EditorPage />,
      },
      {
        path: "calendar",
        element: <CalendarPage />,
      },
      {
        path: "settings",
        element: <SettingsPage />,
      },
    ],
  },
  {
    path: "/home",
    element: (
      <WebOnlyGuard>
        <HomePage />
      </WebOnlyGuard>
    ),
  },
  {
    path: "/privacy",
    element: (
      <WebOnlyGuard>
        <PrivacyPage />
      </WebOnlyGuard>
    ),
  },
  {
    path: "*",
    element: <Navigate to="/" replace />,
  },
]);
