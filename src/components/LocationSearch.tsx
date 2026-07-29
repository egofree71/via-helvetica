/**
 * Business context: provides a compact, keyboard-accessible search field for
 * official Swiss places or pasted coordinates while keeping the map visible
 * beneath temporary results.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useI18n } from '../i18n/I18nContext';
import {
  isCoordinateSearchDraft,
  parseCoordinateSearch,
} from '../search/coordinateSearch';
import {
  getCachedLocationSearch,
  searchLocations,
  type LocationSearchResult,
} from '../search/locationSearch';

/** Callbacks supplied by the map shell to the presentation-only search control. */
interface LocationSearchProps {
  /** Closes map information when the search field becomes active. */
  onSearchFocus: () => void;
  /** Moves the map to the selected place or coordinate result. */
  onSelect: (result: LocationSearchResult) => void;
  /** Removes the temporary map marker when its search context is edited. */
  onClear: () => void;
}

/** Request lifecycle used to render loading, results, and retryable errors. */
type SearchStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error'
  | 'coordinate-outside';

/** Minimum characters required before GeoAdmin is queried. */
const MINIMUM_QUERY_LENGTH = 2;
/** Debounce delay in milliseconds to avoid a request for every keystroke. */
const SEARCH_DELAY_MS = 300;

/**
 * Renders the keyboard-accessible place and coordinate search control. Text
 * searches stay debounced, while coordinate parsing remains immediate and local.
 * Network cancellation and stale-result protection remain local to the control,
 * while map movement is delegated through the supplied callbacks.
 */
export default function LocationSearch({
  onSearchFocus,
  onSelect,
  onClear,
}: LocationSearchProps) {
  const { language, t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedLabelRef = useRef<string | null>(null);
  const listboxId = useId();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LocationSearchResult[]>([]);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !containerRef.current?.contains(event.target)
      ) {
        setIsOpen(false);
        setActiveIndex(-1);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, []);

  useEffect(() => {
    if (!isOpen || activeIndex < 0) {
      return;
    }

    const activeOption = document.getElementById(
      `${listboxId}-${activeIndex}`,
    );

    // aria-activedescendant updates assistive technology, but the browser does
    // not automatically keep the visually active option inside a short panel.
    activeOption?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, isOpen, listboxId]);

  useEffect(() => {
    if (selectedLabelRef.current === query) {
      // The selected label is already the complete search context. Reopening
      // suggestions here would obscure the map immediately after selection.
      return;
    }

    selectedLabelRef.current = null;
    const searchText = query.trim();
    const coordinateSearch = parseCoordinateSearch(searchText);

    setActiveIndex(-1);

    if (coordinateSearch.kind === 'result') {
      // Coordinate parsing is deliberately synchronous and local: a pasted
      // coordinate should never wait for the debounce or contact GeoAdmin.
      setResults([coordinateSearch.result]);
      setStatus('ready');
      setIsOpen(true);
      setActiveIndex(0);
      return;
    }

    if (coordinateSearch.kind === 'outside-map') {
      setResults([]);
      setStatus('coordinate-outside');
      setIsOpen(true);
      return;
    }

    if (isCoordinateSearchDraft(searchText)) {
      // An unfinished numeric coordinate should remain a quiet local workflow.
      // This avoids pointless SearchServer traffic and no-result flicker while
      // preserving ordinary postal-code and place-name searches.
      setResults([]);
      setStatus('idle');
      setIsOpen(false);
      return;
    }

    if (searchText.length < MINIMUM_QUERY_LENGTH) {
      setResults([]);
      setStatus('idle');
      setIsOpen(false);
      return;
    }

    const cachedResults = getCachedLocationSearch(
      searchText,
      language,
    );

    if (cachedResults !== null) {
      // Exact cache hits bypass both the debounce and the loading state so
      // backspacing or retyping a recent place feels immediate.
      setResults(cachedResults);
      setStatus('ready');
      setIsOpen(true);
      return;
    }

    const abortController = new AbortController();

    const timeoutId = window.setTimeout(async () => {
      setStatus('loading');
      setIsOpen(true);

      try {
        const nextResults = await searchLocations(
          searchText,
          language,
          abortController.signal,
        );

        setResults(nextResults);
        setStatus('ready');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }

        console.error('Location search failed.', error);
        setResults([]);
        setStatus('error');
      }
    }, SEARCH_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
      abortController.abort();
    };
  }, [language, query]);

  const handleQueryChange = (nextQuery: string) => {
    if (
      selectedLabelRef.current !== null &&
      nextQuery !== selectedLabelRef.current
    ) {
      // The marker and selected label form one temporary context. Editing the
      // label invalidates the old marker before a replacement is selected.
      selectedLabelRef.current = null;
      onClear();
    }

    setQuery(nextQuery);
  };

  const selectResult = (result: LocationSearchResult) => {
    selectedLabelRef.current = result.label;
    setQuery(result.label);
    setResults([]);
    setStatus('idle');
    setIsOpen(false);
    setActiveIndex(-1);
    onSelect(result);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setIsOpen(false);
      setActiveIndex(-1);
      return;
    }

    if (!isOpen || results.length === 0) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % results.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) =>
        current <= 0 ? results.length - 1 : current - 1,
      );
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(results.length - 1);
      return;
    }

    if (event.key === 'Enter') {
      const selectedIndex =
        activeIndex >= 0 ? activeIndex : results.length === 1 ? 0 : -1;

      if (selectedIndex >= 0) {
        event.preventDefault();
        selectResult(results[selectedIndex]);
      }
    }
  };

  const clearSearch = () => {
    selectedLabelRef.current = null;
    onClear();
    setQuery('');
    setResults([]);
    setStatus('idle');
    setIsOpen(false);
    setActiveIndex(-1);
  };

  const showPanel =
    isOpen && query.trim().length >= MINIMUM_QUERY_LENGTH;
  const showResults = showPanel && results.length > 0;

  return (
    <div className="location-search" ref={containerRef}>
      <div className="location-search-field">
        <svg
          className="location-search-icon"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 5 5" />
        </svg>

        <input
          type="search"
          value={query}
          placeholder={t('search.placeholder')}
          aria-label={t('search.label')}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showPanel}
          aria-controls={showResults ? listboxId : undefined}
          aria-activedescendant={
            activeIndex >= 0
              ? `${listboxId}-${activeIndex}`
              : undefined
          }
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => handleQueryChange(event.target.value)}
          onFocus={() => {
            // Focusing a populated search can immediately reopen cached
            // suggestions, so map-information panels must be cleared first.
            onSearchFocus();

            if (
              query.trim().length >= MINIMUM_QUERY_LENGTH &&
              (results.length > 0 || status !== 'idle')
            ) {
              setIsOpen(true);
            }
          }}
          onKeyDown={handleKeyDown}
        />

        {query && (
          <button
            type="button"
            className="location-search-clear"
            aria-label={t('search.clearLabel')}
            title={t('search.clearTitle')}
            onClick={clearSearch}
          >
            ×
          </button>
        )}
      </div>

      {showPanel && (
        <div className="location-search-panel">
          {status === 'loading' && (
            <div className="location-search-status" role="status">
              {t('search.loading')}
            </div>
          )}

          {status === 'error' && (
            <div
              className="location-search-status location-search-status--error"
              role="alert"
            >
              {t('search.unavailable')}
            </div>
          )}

          {status === 'coordinate-outside' && (
            <div className="location-search-status" role="alert">
              {t('search.coordinatesOutside')}
            </div>
          )}

          {status === 'ready' && results.length === 0 && (
            <div className="location-search-status">
              {t('search.noResults')}
            </div>
          )}

          {showResults && (
            <ul
              id={listboxId}
              className="location-search-results"
              role="listbox"
              aria-label={t('search.results')}
            >
              {results.map((result, index) => (
                <li key={result.id} role="presentation">
                  <button
                    id={`${listboxId}-${index}`}
                    type="button"
                    className={[
                      'location-search-result',
                      index === activeIndex
                        ? 'location-search-result--active'
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === activeIndex}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => selectResult(result)}
                  >
                    <svg
                      className="location-search-result-icon"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="M12 21s6-5.1 6-11a6 6 0 1 0-12 0c0 5.9 6 11 6 11Z" />
                      <circle cx="12" cy="10" r="2.2" />
                    </svg>

                    <span className="location-search-result-text">
                      <strong>{result.label}</strong>
                      <span>
                        {t(`search.category.${result.origin}`)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
