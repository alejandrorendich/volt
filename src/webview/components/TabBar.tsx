/**
 * @fileoverview TabBar — multiple open request tabs with unsaved indicator.
 *
 * Renders the list of open request tabs above the RequestBuilder. Each tab
 * shows a short name (method + path) and a dot indicator when unsaved changes
 * exist. Tabs can be added and closed.
 *
 * @see REQ-RB-007 — Multiple open requests with unsaved indicator dot
 */

import React, { memo, useCallback } from 'react';
import { useRequestStore } from '../stores/request-store';
import './TabBar.css';

export const TabBar = memo(function TabBar(): React.ReactElement {
  const tabs = useRequestStore((s) => s.tabs);
  const activeTabId = useRequestStore((s) => s.activeTabId);
  const switchTab = useRequestStore((s) => s.switchTab);
  const closeTab = useRequestStore((s) => s.closeTab);
  const addTab = useRequestStore((s) => s.addTab);

  const handleClose = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation();
      closeTab(tabId);
    },
    [closeTab],
  );

  return (
    <div className="tab-bar" role="tablist" aria-label="Open requests">
      {tabs.map((tab) => (
        <button
          key={tab.tabId}
          role="tab"
          type="button"
          className={`tab-bar__tab${tab.tabId === activeTabId ? ' tab-bar__tab--active' : ''}`}
          onClick={() => switchTab(tab.tabId)}
          aria-selected={tab.tabId === activeTabId}
          title={tab.name}
        >
          {/* Unsaved indicator dot (REQ-RB-007) */}
          {tab.dirty && (
            <span
              className="tab-bar__dirty"
              aria-label="Unsaved changes"
              title="Unsaved changes"
            />
          )}
          <span className="tab-bar__name">{tab.name}</span>
          {tabs.length > 1 && (
            <span
              className="tab-bar__close"
              role="button"
              aria-label={`Close ${tab.name}`}
              tabIndex={0}
              onClick={(e) => handleClose(e, tab.tabId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  closeTab(tab.tabId);
                }
              }}
            >
              ×
            </span>
          )}
        </button>
      ))}

      {/* Add new tab */}
      <button
        type="button"
        className="tab-bar__add"
        onClick={addTab}
        aria-label="New request tab"
        title="New request"
      >
        +
      </button>
    </div>
  );
});
