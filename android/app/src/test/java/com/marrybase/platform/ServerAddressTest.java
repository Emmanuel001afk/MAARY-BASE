package com.marrybase.platform;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

public class ServerAddressTest {

    @Test
    public void normalizesHttpsAddresses() {
        assertEquals("https://api.example.com", ServerAddress.normalize("https://api.example.com/"));
        assertEquals("https://api.example.com", ServerAddress.normalize("  api.example.com  "));
        assertEquals("https://api.example.com:8443", ServerAddress.normalize("https://api.example.com:8443/"));
    }

    @Test
    public void stripsStudioPaths() {
        assertEquals("http://10.0.2.2:4100", ServerAddress.normalize("http://10.0.2.2:4100/dashboard"));
        assertEquals("https://base.example.com/api", ServerAddress.normalize("https://base.example.com/api/"));
    }

    @Test
    public void allowsPrivateAddressesOverHttp() {
        assertEquals("http://10.0.2.2:4100", ServerAddress.normalize("http://10.0.2.2:4100"));
        assertEquals("https://192.168.1.20:4100", ServerAddress.normalize("192.168.1.20:4100"));
        assertEquals("http://localhost:4100", ServerAddress.normalize("http://localhost:4100"));
        assertEquals("http://127.0.0.1:4100", ServerAddress.normalize("http://127.0.0.1:4100"));
        assertEquals("http://172.16.4.2", ServerAddress.normalize("http://172.16.4.2"));
    }

    @Test
    public void rejectsPlainHttpForPublicHosts() {
        try {
            ServerAddress.normalize("http://example.com");
            fail("Expected http://example.com to be rejected");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("HTTPS"));
        }
    }

    @Test
    public void rejectsUnsafeOrMalformedInput() {
        for (String value : new String[]{
            "",
            "   ",
            "ftp://example.com",
            "https://user:secret@example.com",
            "https://example.com/path?token=1",
            "https://example.com/#fragment",
            "not a url"
        }) {
            try {
                ServerAddress.normalize(value);
                fail("Expected rejection for: " + value);
            } catch (IllegalArgumentException expected) {
                // Expected.
            }
        }
    }

    @Test
    public void classifiesPrivateHosts() {
        assertTrue(ServerAddress.isPrivateHost("10.0.0.5"));
        assertTrue(ServerAddress.isPrivateHost("172.20.1.1"));
        assertTrue(ServerAddress.isPrivateHost("192.168.0.7"));
        assertTrue(ServerAddress.isPrivateHost("169.254.1.1"));
        assertTrue(ServerAddress.isPrivateHost("localhost"));
        assertTrue(ServerAddress.isPrivateHost("10.0.2.2"));
        assertFalse(ServerAddress.isPrivateHost("172.32.0.1"));
        assertFalse(ServerAddress.isPrivateHost("8.8.8.8"));
        assertFalse(ServerAddress.isPrivateHost("example.com"));
    }

    @Test
    public void derivesEndpoints() {
        String base = "https://base.example.com:4100";
        assertEquals("https://base.example.com:4100/dashboard", ServerAddress.studioUrl(base));
        assertEquals("https://base.example.com:4100/ready", ServerAddress.readyUrl(base));
        assertEquals(ServerAddress.Scheme.HTTPS, ServerAddress.schemeOf(base));
        assertEquals(ServerAddress.Scheme.HTTP, ServerAddress.schemeOf("http://10.0.2.2:4100"));
    }
}
