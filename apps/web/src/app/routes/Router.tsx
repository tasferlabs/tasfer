import { getClientPlatform } from "@/platform";
import React from "react";
import {
  Navigate,
  createBrowserRouter,
  createHashRouter,
  redirect,
} from "react-router-dom";
import Layout from "../layout/Layout";
import { RouteErrorBoundary } from "./RouteErrorBoundary";

const EditorPage = React.lazy(() => import("../pages/EditorPage"));
const CalendarPage = React.lazy(
  () => import("../pages/CalendarPage/CalendarPage"),
);
const SettingsPage = React.lazy(
  () => import("../pages/SettingsPage/SettingsPage"),
);
const ArchivePage = React.lazy(
  () => import("../pages/ArchivePage/ArchivePage"),
);

const createRouter =
  getClientPlatform() === "web" ? createBrowserRouter : createHashRouter;

// "/app/" when served as a microfrontend child on the web; "./" in native
// builds, where the hash router needs no basename.
const base = import.meta.env.BASE_URL;
const basename = base.startsWith("/") ? base.replace(/\/$/, "") || "/" : "/";

export const router = createRouter(
  [
    {
      path: "/",
      element: <Layout />,
      errorElement: <RouteErrorBoundary />,
      children: [
        {
          index: true,
          loader: () => {
            const lastRoute = localStorage.getItem("lastRoute");

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
        {
          path: "archive",
          element: <ArchivePage />,
        },
      ],
    },
    {
      path: "*",
      element: <Navigate to="/" replace />,
    },
  ],
  { basename },
);
