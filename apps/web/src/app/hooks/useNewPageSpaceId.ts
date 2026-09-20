import { useMatch } from "react-router-dom";
import { useGetPage } from "../api/pages.api";
import { useSpaces } from "../contexts/SpaceContext";

/**
 * The space a page created from the app chrome (command center, import) should
 * land in: the space of the page on screen, so it appears next to what the
 * person was just looking at. Off a page, the first space.
 */
export function useNewPageSpaceId(): string | null {
  const { firstSpaceId } = useSpaces();
  const openPageId = useMatch("/page/:id")?.params.id;
  const { data: openPage } = useGetPage(openPageId);
  return openPage?.spaceId ?? firstSpaceId;
}
