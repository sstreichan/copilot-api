const PORT_RANGE_BASE = 20_000
const PORT_BLOCK_SIZE = 10
const PID_PORT_SPREAD = 4_000

export function createTestPortAllocator(fileSalt: number) {
  let nextBlock = 0

  return (count: number): Array<number> => {
    const blockStart =
      PORT_RANGE_BASE
      + (process.pid % PID_PORT_SPREAD) * PORT_BLOCK_SIZE
      + fileSalt
      + nextBlock * PORT_BLOCK_SIZE

    nextBlock += Math.max(1, Math.ceil(count / PORT_BLOCK_SIZE))

    return Array.from({ length: count }, (_, index) => blockStart + index)
  }
}
