import { getClientPlatform } from "@/platform";
import React from "react";
import {
  Navigate,
  createBrowserRouter,
  createHashRouter,
  redirect,
} from "react-router-dom";
import Layout from "../layout/Layout";

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
