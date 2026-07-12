"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

/** Define (ou limpa, com null) o WhatsApp de notificação de um membro. */
export function useSetNotifyPhone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { userId: string; phone: string | null }) =>
      apiClient.patch<{ data: { user_id: string; notify_whatsapp_e164: string | null } }>(
        `/api/v1/team/${args.userId}/notify-phone`,
        { notify_whatsapp_e164: args.phone },
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team"] });
    },
  });
}
