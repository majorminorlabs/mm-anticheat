      try {
        const file = resolve(this.vitest.config.root, key.slice(prefix.length))
        const stats = statSync(file, { throwIfNoEntry: false })
        if (stats) {
          return { size: stats.size }
        }
      } catch {}
