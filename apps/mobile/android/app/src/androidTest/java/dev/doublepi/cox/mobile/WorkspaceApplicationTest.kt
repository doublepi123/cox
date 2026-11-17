package dev.doublepi.cox.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WorkspaceApplicationTest {
    @Test fun installsAlongsideTheStandaloneClient() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals("dev.doublepi.cox.mobile", context.packageName)
    }
}
