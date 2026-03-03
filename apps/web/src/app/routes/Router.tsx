import React from "react";
import { Navigate, createBrowserRouter } from "react-router-dom";
import Layout from "../layout/Layout";
import { RequireAuth, RedirectIfAuthed } from "./AuthGuard";

const EditorPage = React.lazy(() => import("../pages/EditorPage"));
const SettingsPage = React.lazy(
  () => import("../pages/SettingsPage/SettingsPage")
);
const LoginPage = React.lazy(() => import("../pages/LoginPage"));
const RegisterPage = React.lazy(() => import("../pages/RegisterPage"));

export const router = createBrowserRouter([
  {
    path: "/login",
    element: (
      <RedirectIfAuthed>
        <LoginPage />
      </RedirectIfAuthed>
    ),
  },
  {
    path: "/register",
    element: (
      <RedirectIfAuthed>
        <RegisterPage />
      </RedirectIfAuthed>
    ),
  },
  {
    path: "/",
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [
      {
        index: true,
        element: <Navigate to="/page" replace />,
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
