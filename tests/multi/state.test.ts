import { describe, it, expect, beforeEach } from "bun:test"

import { TUIStateManager } from "~/multi/state"

describe("TUIStateManager", () => {
  let manager: TUIStateManager
  let onQuitCalls: number
  let onRestartCalls: Array<string>
  let onRestartAllCalls: number

  beforeEach(() => {
    onQuitCalls = 0
    onRestartCalls = []
    onRestartAllCalls = 0

    const onQuit = () => {
      onQuitCalls++
    }
    const onRestart = (name: string) => {
      onRestartCalls.push(name)
    }
    const onRestartAll = () => {
      onRestartAllCalls++
    }

    manager = new TUIStateManager(["app1", "app2", "app3"], {
      onQuit,
      onRestart,
      onRestartAll,
    })
  })

  // Navigation tests
  describe("Navigation", () => {
    it("should initialize with selectedIndex = 1 (first instance)", () => {
      expect(manager.selectedIndex).toBe(1)
    })

    it("should return null when selectedIndex === 0 ([ALL] sentinel)", () => {
      manager.selectedIndex = 0
      expect(manager.getSelectedName()).toBeNull()
    })

    it("should navigate down: 1 → 2 → 3", () => {
      expect(manager.selectedIndex).toBe(1)
      manager.navigateDown()
      expect(manager.selectedIndex).toBe(2)
      manager.navigateDown()
      expect(manager.selectedIndex).toBe(3)
    })

    it("should wrap around when navigating down from last item", () => {
      // 4 items total: [ALL], app1, app2, app3 (indices 0, 1, 2, 3)
      manager.selectedIndex = 3
      manager.navigateDown()
      expect(manager.selectedIndex).toBe(0)
    })

    it("should navigate up: 3 → 2 → 1", () => {
      manager.selectedIndex = 3
      manager.navigateUp()
      expect(manager.selectedIndex).toBe(2)
      manager.navigateUp()
      expect(manager.selectedIndex).toBe(1)
    })

    it("should wrap around when navigating up from [ALL]", () => {
      manager.selectedIndex = 0
      manager.navigateUp()
      expect(manager.selectedIndex).toBe(3) // last index
    })
  })

  // Layout mode tests
  describe("Layout mode", () => {
    it("should return narrow for width < 75", () => {
      expect(manager.getLayoutMode(40)).toBe("narrow")
    })

    it("should return narrow for width = 74", () => {
      expect(manager.getLayoutMode(74)).toBe("narrow")
    })

    it("should return wide for width >= 75", () => {
      expect(manager.getLayoutMode(75)).toBe("wide")
    })

    it("should return wide for width > 75", () => {
      expect(manager.getLayoutMode(120)).toBe("wide")
    })
  })

  // Dispatch tests
  describe("Dispatch", () => {
    it("should dispatch navigate-up correctly", () => {
      manager.selectedIndex = 2
      manager.dispatch("navigate-up")
      expect(manager.selectedIndex).toBe(1)
    })

    it("should dispatch navigate-down correctly", () => {
      manager.selectedIndex = 1
      manager.dispatch("navigate-down")
      expect(manager.selectedIndex).toBe(2)
    })

    it("should dispatch quit and call onQuit callback", () => {
      manager.dispatch("quit")
      expect(onQuitCalls).toBe(1)
    })

    it("should dispatch restart with selected instance name", () => {
      manager.selectedIndex = 1
      manager.dispatch("restart")
      expect(onRestartCalls).toEqual(["app1"])
    })

    it("should not call onRestart when [ALL] is selected", () => {
      manager.selectedIndex = 0
      manager.dispatch("restart")
      expect(onRestartCalls).toHaveLength(0)
    })

    it("should dispatch restart-all correctly", () => {
      manager.dispatch("restart-all")
      expect(onRestartAllCalls).toBe(1)
    })
  })

  // Edge cases
  describe("Edge cases", () => {
    it("should handle single instance correctly", () => {
      const singleManager = new TUIStateManager(["solo"], {
        onQuit: () => {},
        onRestart: () => {},
        onRestartAll: () => {},
      })
      expect(singleManager.selectedIndex).toBe(1)
      singleManager.navigateDown()
      expect(singleManager.selectedIndex).toBe(0)
      singleManager.navigateDown()
      expect(singleManager.selectedIndex).toBe(1) // wrap
    })

    it("should return valid name from getSelectedName when index > 0", () => {
      manager.selectedIndex = 1
      expect(manager.getSelectedName()).toBe("app1")
      manager.selectedIndex = 2
      expect(manager.getSelectedName()).toBe("app2")
      manager.selectedIndex = 3
      expect(manager.getSelectedName()).toBe("app3")
    })

    it("should return correct items including sentinel", () => {
      const items = manager.getItems()
      expect(items).toEqual(["[ALL]", "app1", "app2", "app3"])
    })

    it("should detect when [ALL] is selected", () => {
      manager.selectedIndex = 0
      expect(manager.isAllSelected()).toBeTrue()
      manager.selectedIndex = 1
      expect(manager.isAllSelected()).toBeFalse()
    })

    it("should handle callbacks being undefined", () => {
      const noCallbackManager = new TUIStateManager(["test"])
      expect(() => {
        noCallbackManager.dispatch("quit")
        noCallbackManager.dispatch("restart")
        noCallbackManager.dispatch("restart-all")
      }).not.toThrow()
    })
  })
})
