import { ShieldAlert } from "lucide-react";
import type { PendingApproval } from "@/lib/use-ema";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function ApprovalDialog({ approval }: { approval: PendingApproval | null }) {
  return (
    <AlertDialog open={Boolean(approval)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 font-display">
            <ShieldAlert className="size-4 text-primary" /> Approval required
          </AlertDialogTitle>
          <AlertDialogDescription>
            EMA wants to do something irreversible. Nothing happens until you approve.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 rounded-md border border-border bg-secondary/40 p-3 text-sm">
          <p className="font-medium">{approval?.summary}</p>
          {approval?.details && (
            <p className="text-xs text-muted-foreground">{approval.details}</p>
          )}
        </div>
        <AlertDialogFooter>
          <Button variant="secondary" onClick={() => approval?.resolve(false)}>
            Deny
          </Button>
          <Button onClick={() => approval?.resolve(true)}>Approve</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
