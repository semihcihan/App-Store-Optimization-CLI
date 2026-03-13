import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_ASO_COUNTRY,
  apiGet,
  toActionableErrorMessage,
} from "../app-helpers";

const APP_SEARCH_DEBOUNCE_MS = 350;
const APP_SEARCH_LIMIT = 20;

type AppSearchDoc = {
  appId: string;
  name: string;
  icon?: Record<string, unknown>;
  iconArtwork?: { url?: string; [key: string]: unknown };
};

type AppSearchResponsePayload = {
  term: string;
  appDocs: AppSearchDoc[];
};

export type AddCandidate = {
  key: string;
  type: "app" | "research";
  label: string;
  appId?: string;
  name?: string;
  icon?: Record<string, unknown>;
  iconArtwork?: { url?: string; [key: string]: unknown };
};

export function useAddAppSearch() {
  const [isAddAppPopoverOpen, setIsAddAppPopoverOpen] = useState(false);
  const [addAppSearchTerm, setAddAppSearchTerm] = useState("");
  const [addAppSearchResults, setAddAppSearchResults] = useState<AppSearchDoc[]>([]);
  const [addAppSearchError, setAddAppSearchError] = useState("");
  const [isAddAppSearching, setIsAddAppSearching] = useState(false);
  const [selectedAddCandidates, setSelectedAddCandidates] = useState<
    Record<string, AddCandidate>
  >({});
  const addAppSearchRequestIdRef = useRef(0);
  const addAppSearchInputRef = useRef<HTMLInputElement | null>(null);

  const trimmedAddAppSearchTerm = addAppSearchTerm.trim();
  const addAppCandidates = useMemo(() => {
    if (!trimmedAddAppSearchTerm) return [] as AddCandidate[];
    const candidates: AddCandidate[] = [
      {
        key: `research:${trimmedAddAppSearchTerm.toLowerCase()}`,
        type: "research",
        label: `Research: ${trimmedAddAppSearchTerm}`,
        name: trimmedAddAppSearchTerm,
      },
    ];
    const seenAppIds = new Set<string>();
    for (const doc of addAppSearchResults) {
      const appId = `${doc.appId ?? ""}`.trim();
      if (!appId || seenAppIds.has(appId)) continue;
      seenAppIds.add(appId);
      const normalizedName = `${doc.name ?? ""}`.trim() || appId;
      candidates.push({
        key: `app:${appId}`,
        type: "app",
        label: normalizedName,
        appId,
        icon: doc.icon,
        iconArtwork: doc.iconArtwork,
      });
    }
    return candidates;
  }, [addAppSearchResults, trimmedAddAppSearchTerm]);

  const selectedAddCandidateList = useMemo(
    () => Object.values(selectedAddCandidates),
    [selectedAddCandidates]
  );

  const resetAddAppPopoverState = useCallback(() => {
    addAppSearchRequestIdRef.current += 1;
    setAddAppSearchTerm("");
    setAddAppSearchResults([]);
    setAddAppSearchError("");
    setIsAddAppSearching(false);
    setSelectedAddCandidates({});
  }, []);

  const closeAddAppPopover = useCallback(() => {
    setIsAddAppPopoverOpen(false);
    resetAddAppPopoverState();
  }, [resetAddAppPopoverState]);

  const openAddAppPopover = useCallback(() => {
    resetAddAppPopoverState();
    setIsAddAppPopoverOpen(true);
  }, [resetAddAppPopoverState]);

  const toggleAddCandidateSelection = useCallback((candidate: AddCandidate) => {
    setSelectedAddCandidates((prev) => {
      const next = { ...prev };
      if (next[candidate.key]) {
        delete next[candidate.key];
      } else {
        next[candidate.key] = candidate;
      }
      return next;
    });
  }, []);

  const removeSelectedCandidates = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    setSelectedAddCandidates((prev) => {
      const next = { ...prev };
      for (const key of keys) {
        delete next[key];
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!isAddAppPopoverOpen) return;
    const timer = window.setTimeout(() => {
      addAppSearchInputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isAddAppPopoverOpen]);

  useEffect(() => {
    if (!isAddAppPopoverOpen) return;

    const term = trimmedAddAppSearchTerm;
    const requestId = ++addAppSearchRequestIdRef.current;

    if (!term) {
      setAddAppSearchResults([]);
      setAddAppSearchError("");
      setIsAddAppSearching(false);
      return;
    }

    setIsAddAppSearching(true);
    setAddAppSearchError("");
    setAddAppSearchResults([]);

    const debounceTimer = window.setTimeout(() => {
      void apiGet<AppSearchResponsePayload>(
        `/api/aso/apps/search?country=${DEFAULT_ASO_COUNTRY}&term=${encodeURIComponent(term)}&limit=${APP_SEARCH_LIMIT}`
      )
        .then((payload) => {
          if (requestId !== addAppSearchRequestIdRef.current) return;
          setAddAppSearchResults(payload.appDocs);
        })
        .catch((error) => {
          if (requestId !== addAppSearchRequestIdRef.current) return;
          setAddAppSearchResults([]);
          setAddAppSearchError(toActionableErrorMessage(error, "Failed to search apps"));
        })
        .finally(() => {
          if (requestId !== addAppSearchRequestIdRef.current) return;
          setIsAddAppSearching(false);
        });
    }, APP_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(debounceTimer);
  }, [isAddAppPopoverOpen, trimmedAddAppSearchTerm]);

  return {
    isAddAppPopoverOpen,
    addAppSearchTerm,
    addAppSearchInputRef,
    addAppSearchError,
    isAddAppSearching,
    selectedAddCandidates,
    selectedAddCandidateList,
    trimmedAddAppSearchTerm,
    addAppCandidates,
    setAddAppSearchTerm,
    openAddAppPopover,
    closeAddAppPopover,
    toggleAddCandidateSelection,
    removeSelectedCandidates,
  };
}
