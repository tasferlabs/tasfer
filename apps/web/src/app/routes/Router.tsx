import React from "react";
import { Navigate, createBrowserRouter } from "react-router-dom";
import Layout from "../layout/Layout";

function RestoreLastRoute() {
  const lastRoute = localStorage.getItem("lastRoute") || "/page";
  return <Navigate to={lastRoute} replace />;
}

const EditorPage = React.lazy(() => import("../pages/EditorPage"));
const CalendarPage = React.lazy(
  () => import("../pages/CalendarPage/CalendarPage"),
);
const SettingsPage = React.lazy(
  () => import("../pages/SettingsPage/SettingsPage"),
);
const HomePage = React.lazy(() => import("../pages/HomePage/HomePage"));

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      {
        index: true,
        element: <RestoreLastRoute />,
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
    element: <HomePage />,
  },
  {
    path: "*",
    element: <Navigate to="/" replace />,
  },
]);
