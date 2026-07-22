import {
  Alert,
  AlertTitle,
  AlertDescription,
  AlertAction,
  Button,
} from "tasfer";
import { CircleAlert, Info, TriangleAlert } from "lucide-react";

export function Default() {
  return (
    <Alert style={{ maxWidth: 460 }}>
      <Info />
      <AlertTitle>Changes saved locally</AlertTitle>
      <AlertDescription>
        Your document is stored on this device and synced to peers when they
        come online.
      </AlertDescription>
    </Alert>
  );
}

export function Destructive() {
  return (
    <Alert variant="destructive" style={{ maxWidth: 460 }}>
      <TriangleAlert />
      <AlertTitle>Sync conflict detected</AlertTitle>
      <AlertDescription>
        Two peers edited the same page offline. Review the differences before
        merging.
      </AlertDescription>
    </Alert>
  );
}

export function WithAction() {
  return (
    <Alert style={{ maxWidth: 460 }}>
      <CircleAlert />
      <AlertTitle>Update available</AlertTitle>
      <AlertDescription>
        A new version of the editor is ready to install.
      </AlertDescription>
      <AlertAction>
        <Button size="xs" variant="outline">
          Reload
        </Button>
      </AlertAction>
    </Alert>
  );
}
