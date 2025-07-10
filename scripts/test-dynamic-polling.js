const { ethers } = require("ethers");
const { log } = require("@sayukixbt/log");

// Mock EventIndexer for testing
class MockEventIndexer {
    constructor() {
        this.lastIndexedBlock = 26497000; // Start behind
    }
    
    async getLastIndexedBlock() {
        return this.lastIndexedBlock;
    }
    
    async updateLastIndexedBlock(blockNumber) {
        this.lastIndexedBlock = blockNumber;
        log.info(`📊 Updated last indexed block to ${blockNumber}`);
    }
    
    async indexEvents(fromBlock, toBlock) {
        log.info(`🔍 Mock indexing events from ${fromBlock} to ${toBlock}`);
        // Simulate some processing time
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

// Mock DualProvider
class MockDualProvider {
    constructor() {
        this.currentBlock = 26498000; // Start ahead
    }
    
    getLocalProvider() {
        return {
            getBlockNumber: async () => {
                // Simulate block progression
                this.currentBlock += 1;
                return this.currentBlock;
            }
        };
    }
    
    async getLatestBlockNumber() {
        return this.currentBlock;
    }
}

// Test the dynamic polling logic
async function testDynamicPolling() {
    log.info("🧪 Testing dynamic polling interval functionality...");
    
    const mockEventIndexer = new MockEventIndexer();
    const mockDualProvider = new MockDualProvider();
    
    // Mock the dualProvider property
    mockEventIndexer.dualProvider = mockDualProvider;
    
    // Create a simplified version of the polling logic
    let isCatchingUp = true;
    let catchupInterval = 1000;
    let localInterval = 100;
    let currentInterval = catchupInterval;
    let lastIndexedBlock = await mockEventIndexer.getLastIndexedBlock();
    
    log.info(`📊 Starting test with last indexed block: ${lastIndexedBlock}`);
    
    for (let i = 0; i < 10; i++) {
        const latestBlock = await mockDualProvider.getLatestBlockNumber();
        const fromBlock = lastIndexedBlock + 1;
        
        // Check if we're caught up
        const wasCatchingUp = isCatchingUp;
        isCatchingUp = fromBlock <= latestBlock;
        
        // Update polling interval if catchup status changed
        if (wasCatchingUp !== isCatchingUp) {
            const newInterval = isCatchingUp ? catchupInterval : localInterval;
            log.info(`🔄 Polling interval changed: ${currentInterval}ms → ${newInterval}ms (${isCatchingUp ? 'catching up' : 'caught up'})`);
            currentInterval = newInterval;
        }
        
        log.info(`📊 Iteration ${i + 1}: latest=${latestBlock}, from=${fromBlock}, catchingUp=${isCatchingUp}, interval=${currentInterval}ms`);
        
        if (fromBlock <= latestBlock) {
            // Simulate indexing
            await mockEventIndexer.indexEvents(fromBlock, Math.min(fromBlock + 999, latestBlock));
            lastIndexedBlock = Math.min(fromBlock + 999, latestBlock);
            await mockEventIndexer.updateLastIndexedBlock(lastIndexedBlock);
        } else {
            log.info(`📊 Caught up to latest block ${latestBlock}`);
        }
        
        // Simulate time passing
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    log.info("✅ Dynamic polling test completed!");
}

// Run the test
testDynamicPolling().catch(console.error); 