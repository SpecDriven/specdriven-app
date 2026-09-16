package acme.policy;

import java.math.BigDecimal;
import java.time.LocalDate;

/** An insurance policy, as the billing and policy specs describe it. */
public class Policy {
    private String policyNumber;
    private String holderName;
    private String email;
    private BigDecimal premium;
    private LocalDate effectiveDate;
    private LocalDate expiryDate;
    private boolean autopay;

    public String getPolicyNumber() {
        return policyNumber;
    }

    public BigDecimal getPremium() {
        return premium;
    }
}
