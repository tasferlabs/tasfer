import React from "react";
import {
  Navigate,
  createBrowserRouter,
  createHashRouter,
  redirect,
} from "react-router-dom";
import Layout from "../layout/Layout";
import { getClientPlatform } from "@/platform";
import { SITE_URL } from "./siteUrl";

const EditorPage = React.lazy(() => import("../pages/EditorPage"));
const CalendarPage = React.lazy(
  () => import("../pages/CalendarPage/CalendarPage"),
);
const SettingsPage = React.lazy(
  () => import("../pages/SettingsPage/SettingsPage"),
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
          // New user on web → the marketing home now lives in the separate site
          // app (apps/site), served at /home. Hard-navigate there (a react-router
          // redirect would stay inside this SPA, which no longer has that route).
          if (!lastRoute && getClientPlatform() === "web") {
            window.location.assign(`${SITE_URL}/home`);
            return null;
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
    path: "*",
    element: <Navigate to="/" replace />,
  },
]);
